// Lead assignment rules and the duplicate-lead check.
//
// One lead, one sales representative. Once a lead is assigned, moving it to
// another representative (or taking the representative off it) is a
// reassignment: only an authorised user — leads.approve (Business Owner, Sales
// & Marketing Manager, Senior Sales Representative; ADM always) — may make it,
// and it is recorded in lead_assignments with who, when and why. Anyone else
// is refused with:
//
//   "This lead has already been assigned to <name>. Please check the existing
//    assignment before proceeding."
//
// The same check runs wherever a salesperson can be set: the assign endpoint,
// PATCH /opportunities/:id and lead creation.
//
// Duplicate leads are found by phone number and email address, not the name,
// so two representatives never chase the same customer: an active lead in the
// same business unit with the same phone (last nine digits, so 0412 345 678
// and +61 412 345 678 match) or the same email (ignoring case).
import { Op } from "sequelize";
import db from "../../../models/index.js";
import { parseId } from "../../../utils/ids.js";
import { userHasPermission } from "../../role/service/roleService.js";
import { notify } from "../../notification/service/notificationService.js";
import { recordActivity } from "../../activity/service/activityService.js";

const { Opportunity, LeadAssignment, User, sequelize } = db;

const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

/** The permission that lets someone reassign a lead and create a lead despite a duplicate. */
export const REASSIGN_PERMISSION = "leads.approve";

export const canReassign = (actor) => userHasPermission(actor, REASSIGN_PERMISSION);

export const alreadyAssignedMessage = (name) =>
    `This lead has already been assigned to ${name || "another sales representative"}. Please check the existing assignment before proceeding.`;

const userName = async (id) => (id ? (await User.findByPk(id, { attributes: ["id", "name"], paranoid: false }))?.name ?? null : null);

/**
 * Throws 409 (the message above) unless `actor` may move the lead from its
 * current representative to `nextId` (null = unassign). Assigning a lead with
 * no representative, or keeping the same one, is always allowed.
 */
export const assertMayChangeSalesperson = async (opportunity, nextId, actor) => {
    const current = opportunity.salespersonId ? Number(opportunity.salespersonId) : null;
    const next = nextId === null || nextId === undefined || nextId === "" ? null : Number(nextId);
    if (!current || current === next) return;
    if (await canReassign(actor)) return;
    const name = await userName(current);
    throw httpError(409, alreadyAssignedMessage(name), {
        errors: [{ field: "salespersonId", message: alreadyAssignedMessage(name) }],
        code: "LEAD_ALREADY_ASSIGNED",
        details: { salesperson: { id: current, name } },
    });
};

/** Records one step of the trail and tells the previous representative when the lead was taken off them. */
export const recordAssignment = async (opportunity, { fromId = null, toId = null, reason = null }, actor, ctx = null) => {
    const from = fromId ? Number(fromId) : null;
    const to = toId ? Number(toId) : null;
    if (from === to) return null;
    const kind = !from ? "assigned" : to ? "reassigned" : "unassigned";
    const row = await LeadAssignment.create({
        opportunityId: opportunity.id,
        fromUserId: from,
        toUserId: to,
        assignedById: actor?.id ?? null,
        kind,
        reason: reason ? String(reason).trim().slice(0, 2000) || null : null,
    });
    const [fromName, toName] = await Promise.all([userName(from), userName(to)]);
    await recordActivity({
        actor, ctx, businessUnitId: opportunity.businessUnitId, entityType: "lead", entityId: opportunity.id, entityLabel: opportunity.number,
        action: `salesperson_${kind}`, changes: { salespersonId: { from: fromName ?? from, to: toName ?? to } }, meta: { reason: row.reason },
    });
    if (kind === "reassigned" && from && from !== actor?.id)
        await notify({
            event: "assignment.salesperson.reassigned",
            title: `${opportunity.number} reassigned to ${toName ?? "another representative"}`,
            body: `The lead was moved from you to ${toName ?? "another representative"}${actor?.name ? ` by ${actor.name}` : ""}${row.reason ? `: ${row.reason}` : "."}`,
            userIds: [from],
            opportunity,
            actor,
        });
    return row;
};

const INCLUDE = [
    { model: User, as: "fromUser", attributes: ["id", "name"], paranoid: false },
    { model: User, as: "toUser", attributes: ["id", "name"], paranoid: false },
    { model: User, as: "assignedBy", attributes: ["id", "name"], paranoid: false },
];

const brief = (u) => (u ? { id: u.id, name: u.name } : null);

/** The lead's assignment trail, newest first, with who holds it now. */
export const listAssignments = async (id) => {
    const opportunity = await Opportunity.findByPk(parseId(id, "opportunity id"), { attributes: ["id", "number", "salespersonId"] });
    if (!opportunity) throw httpError(404, "Opportunity not found");
    const rows = await LeadAssignment.findAll({ where: { opportunityId: opportunity.id }, include: INCLUDE, order: [["createdAt", "DESC"], ["id", "DESC"]] });
    const current = opportunity.salespersonId ? await User.findByPk(opportunity.salespersonId, { attributes: ["id", "name"], paranoid: false }) : null;
    return {
        current: brief(current),
        assignedAt: rows.find((r) => r.toUserId && r.toUserId === opportunity.salespersonId)?.createdAt ?? null,
        history: rows.map((r) => ({
            id: r.id,
            kind: r.kind,
            from: brief(r.fromUser),
            to: brief(r.toUser),
            by: brief(r.assignedBy),
            reason: r.reason ?? null,
            at: r.createdAt,
        })),
    };
};

// ---- Duplicate leads --------------------------------------------------------

/** The digits that identify a phone number: the last nine (Australian numbers, with or without +61 / 0). */
export const phoneKey = (value) => {
    const digits = String(value ?? "").replace(/\D/g, "");
    return digits.length >= 8 ? digits.slice(-9) : null;
};

export const emailKey = (value) => {
    const email = String(value ?? "").trim().toLowerCase();
    return email.includes("@") ? email : null;
};

const phoneSql = (column) => `RIGHT(regexp_replace(COALESCE(${column}, ''), '[^0-9]', '', 'g'), 9)`;

/**
 * Active leads in the unit that share a phone number or email with the given
 * contact details: [{ id, number, stage, customer, salesperson, matchedOn: ["phone" | "email"] }].
 */
export const findDuplicateLeads = async ({ businessUnitId, phone, email, contactPhone, contactEmail, excludeId = null } = {}, { transaction = null } = {}) => {
    const unitId = parseId(businessUnitId, "businessUnitId");
    const phones = [...new Set([phoneKey(phone), phoneKey(contactPhone)].filter(Boolean))];
    const emails = [...new Set([emailKey(email), emailKey(contactEmail)].filter(Boolean))];
    if (!phones.length && !emails.length) return [];
    const ors = [];
    if (phones.length) {
        ors.push(sequelize.where(sequelize.literal(phoneSql('"Opportunity"."customer_phone"')), { [Op.in]: phones }));
        ors.push(sequelize.where(sequelize.literal(phoneSql('"Opportunity"."contact_phone"')), { [Op.in]: phones }));
    }
    if (emails.length) {
        ors.push(sequelize.where(sequelize.fn("lower", sequelize.col("Opportunity.customer_email")), { [Op.in]: emails }));
        ors.push(sequelize.where(sequelize.fn("lower", sequelize.col("Opportunity.contact_email")), { [Op.in]: emails }));
    }
    const rows = await Opportunity.findAll({
        where: { businessUnitId: unitId, lifecycle: "Active", ...(excludeId ? { id: { [Op.ne]: excludeId } } : {}), [Op.or]: ors },
        attributes: ["id", "number", "stage", "customerLegalName", "customerTradingName", "customerFirstName", "customerLastName", "customerPhone", "customerEmail", "contactPhone", "contactEmail", "salespersonId", "createdAt"],
        include: [{ model: User, as: "salesperson", attributes: ["id", "name"] }],
        order: [["createdAt", "ASC"]],
        limit: 20,
        transaction,
    });
    return rows.map((r) => {
        const matchedOn = [];
        if (phones.length && [phoneKey(r.customerPhone), phoneKey(r.contactPhone)].some((p) => p && phones.includes(p))) matchedOn.push("phone");
        if (emails.length && [emailKey(r.customerEmail), emailKey(r.contactEmail)].some((e) => e && emails.includes(e))) matchedOn.push("email");
        return {
            id: r.id,
            number: r.number,
            stage: r.stage,
            customer: r.customerLegalName || r.customerTradingName || [r.customerFirstName, r.customerLastName].filter(Boolean).join(" ") || null,
            salesperson: brief(r.salesperson),
            matchedOn,
            createdAt: r.createdAt,
        };
    });
};

/**
 * How lead creation treats a duplicate: block (the default — refuse with 409),
 * warn (create it, and report the matches) or off. LEAD_DUPLICATE_CHECK sets it.
 */
export const duplicateMode = () => {
    const mode = String(process.env.LEAD_DUPLICATE_CHECK ?? "block").trim().toLowerCase();
    return ["block", "warn", "off"].includes(mode) ? mode : "block";
};

/** The 409 for a lead that already exists — naming its representative when it has one. */
export const duplicateError = (matches) => {
    const first = matches[0];
    const on = first.matchedOn.join(" and ") || "contact details";
    const message = first.salesperson
        ? `${alreadyAssignedMessage(first.salesperson.name)} (${first.number} has the same ${on}.)`
        : `This customer already has an active lead, ${first.number}, with the same ${on}. Please check the existing lead before proceeding.`;
    return httpError(409, message, {
        code: "DUPLICATE_LEAD",
        details: { duplicates: matches },
        errors: [{ field: first.matchedOn.includes("phone") ? "customerPhone" : "customerEmail", message }],
    });
};
