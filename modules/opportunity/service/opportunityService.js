// Lead-stage CRUD for opportunities. A "lead" is an opportunity at stage 1;
// creating one snapshots the unit's margin floor and starts the stage-1 SLA
// clock from the unit's slaDays config. Later stages get their own services
// as the pipeline modules ship.
import { Op } from "sequelize";
import db from "../../../models/index.js";
import { parseId } from "../../../utils/ids.js";
import { hasDocumentOfType, presentDocument } from "./leadAttachmentService.js";
import { isEstimationReady } from "./estimationService.js";
import { quoteHasItems } from "./quoteService.js";
import { notify } from "../../notification/service/notificationService.js";
import { assignedUserIds, customerLabel } from "./opportunityPeople.js";

const { Opportunity, BusinessUnit, Referrer, User, Document, sequelize } = db;

const httpError = (status, message) => Object.assign(new Error(message), { status });

// Sources a person can pick on the form. The ad/ServiceM8 sources are set by
// inbound-lead conversion only, never by hand.
const MANUAL_LEAD_SOURCES = ["internal", "inbound", "referrer"];

// Fields the client may set directly; everything else (number, stage,
// lifecycle, SLA, margin floor, owners' audit trail) is server-managed.
// Assignments (salesperson, estimator, operational coordinator) have their own
// endpoints in leadWorkflowService; the legacy estimatorId/salespersonId
// fields stay accepted here for older callers.
const LEAD_FIELDS = [
    "customerLegalName", "customerTradingName", "customerAbn", "customerEmail",
    "customerPhone", "customerBillingAddress",
    "siteLine1", "siteSuburb", "siteState", "sitePostcode", "siteJurisdiction",
    "siteContact", "siteAccessNotes", "siteMapUrl",
    "contactName", "contactRole", "contactEmail", "contactPhone",
    "qualification", "qualificationAuthority", "qualificationTiming",
    "estimatedValue", "nextAction", "nextActionDueAt",
    "energyAnnualKwh", "energyHasBills", "energyNotes",
    "leadSource", "leadSourceDetails", "referrerId", "involvementTier", "leadType",
    "needsClientContact", "contactAttempts",
    "hasOwnerDiscount", "ownerDiscountName", "ownerDiscountAmount",
    "needsClientVisit", "clientVisitReason", "customFields", "notPotentialReason",
    "estimatorId", "salespersonId", "notes",
];
const BOOLEAN_FIELDS = ["energyHasBills", "needsClientContact", "hasOwnerDiscount", "needsClientVisit"];
const NUMERIC_FIELDS = ["energyAnnualKwh", "estimatedValue", "ownerDiscountAmount"];
const MAX_LENGTH = { siteMapUrl: 1000, leadSourceDetails: 500, customerAbn: 20, siteState: 10, sitePostcode: 10, siteJurisdiction: 10 };

const toBool = (value) => value === true || value === 1 || value === "true" || value === "1";
const text = (value, max) => String(value ?? "").trim().slice(0, max);

// [{ method, contactedAt, reached, reason }] — kept as given, trimmed and capped.
const sanitizeContactAttempts = (list) => {
    if (!Array.isArray(list)) throw httpError(400, "contactAttempts must be an array");
    if (list.length > 50) throw httpError(400, "contactAttempts: at most 50 entries");
    return list.map((a) => {
        const contactedAt = a?.contactedAt ? String(a.contactedAt).slice(0, 10) : null;
        if (contactedAt && Number.isNaN(new Date(contactedAt).getTime()))
            throw httpError(400, "contactAttempts: contactedAt must be a date");
        return {
            method: text(a?.method, 200),
            contactedAt,
            reached: a?.reached !== false && a?.reached !== "false",
            reason: text(a?.reason, 2000),
        };
    });
};

// [{ label, value }]
const sanitizeCustomFields = (list) => {
    if (!Array.isArray(list)) throw httpError(400, "customFields must be an array");
    if (list.length > 50) throw httpError(400, "customFields: at most 50 entries");
    return list
        .map((f) => ({ label: text(f?.label, 100), value: text(f?.value, 1000) }))
        .filter((f) => f.label || f.value);
};

const pickLeadFields = (payload) => {
    const picked = {};
    for (const field of LEAD_FIELDS) if (payload[field] !== undefined) picked[field] = payload[field];
    for (const field of BOOLEAN_FIELDS) if (picked[field] !== undefined) picked[field] = toBool(picked[field]);
    if (picked.leadType === "") picked.leadType = null; // model validates the value otherwise
    for (const numeric of NUMERIC_FIELDS) {
        if (picked[numeric] === "" || picked[numeric] === null) picked[numeric] = null;
        else if (picked[numeric] !== undefined && !Number.isFinite(Number(picked[numeric])))
            throw httpError(400, `${numeric} must be a number`);
    }
    for (const [field, max] of Object.entries(MAX_LENGTH))
        if (typeof picked[field] === "string" && picked[field].length > max)
            throw httpError(400, `${field} is too long (${max} characters max)`);
    if (picked.contactAttempts !== undefined) picked.contactAttempts = sanitizeContactAttempts(picked.contactAttempts);
    if (picked.customFields !== undefined) picked.customFields = sanitizeCustomFields(picked.customFields);
    if (picked.hasOwnerDiscount === false) {
        picked.ownerDiscountName = null;
        picked.ownerDiscountAmount = null;
    }
    if (picked.needsClientVisit === false) picked.clientVisitReason = null;
    if (picked.needsClientContact === false) picked.contactAttempts = [];
    return picked;
};

const assertUserExists = async (id, label) => {
    if (id === undefined || id === null || id === "") return null;
    const user = await User.findByPk(parseId(id, label));
    if (!user) throw httpError(400, `Unknown user for ${label}`);
    return user.id;
};

// Referrer-sourced leads need the referrer and a commission tier; any other
// source must not carry referrer attribution.
const normalizeSource = async (fields) => {
    if (fields.leadSource !== undefined && !MANUAL_LEAD_SOURCES.includes(fields.leadSource))
        throw httpError(400, `leadSource must be one of: ${MANUAL_LEAD_SOURCES.join(", ")}`);
    if (fields.leadSource === "referrer") {
        if (!fields.referrerId) throw httpError(400, "A referrer-sourced lead needs referrerId");
        const referrer = await Referrer.findByPk(parseId(fields.referrerId, "referrer id"));
        if (!referrer) throw httpError(400, "Unknown referrer");
        fields.referrerId = referrer.id;
        fields.involvementTier = fields.involvementTier || "lead_only";
    } else if (fields.leadSource !== undefined) {
        fields.referrerId = null;
        fields.involvementTier = null;
    }
    return fields;
};

// ---- Numbering --------------------------------------------------------------
// PRS-26-0042: unit code, two-digit year, sequence. Reading the last number
// and inserting the next is a classic race (two concurrent creates — e.g. the
// public form — would pick the same sequence and the loser would trip the
// unique index with a 500), so creation runs inside one transaction that
// first takes a per-unit advisory lock. The lock is released on commit or
// rollback, and other units are never blocked.

// First key of the two-int advisory lock, so this lock never collides with
// any other pg_advisory_xact_lock the app may add later.
const NUMBERING_LOCK_KEY = 1;

const lockNumbering = (unit, transaction) =>
    sequelize.query("SELECT pg_advisory_xact_lock(:key, :unitId)", {
        replacements: { key: NUMBERING_LOCK_KEY, unitId: unit.id },
        transaction,
    });

// Soft-deleted rows keep their number, so the scan is unscoped by paranoid to
// avoid reuse. Must be called with the numbering lock held (see createLead).
const nextNumber = async (unit, transaction) => {
    const year = String(new Date().getFullYear()).slice(-2);
    const prefix = `${unit.code}-${year}-`;
    const last = await Opportunity.findOne({
        where: { number: { [Op.like]: `${prefix}%` } },
        // Longest number first, then lexical: with a fixed prefix that is
        // numeric order, so 10000 still sorts above 9999 once the padding
        // is outgrown.
        order: [[sequelize.fn("LENGTH", sequelize.col("number")), "DESC"], ["number", "DESC"]],
        paranoid: false,
        transaction,
    });
    const lastSequence = last ? Number(last.number.slice(prefix.length)) : 0;
    const sequence = (Number.isInteger(lastSequence) && lastSequence > 0 ? lastSequence : 0) + 1;
    return `${prefix}${String(sequence).padStart(4, "0")}`;
};

export const listOpportunities = async ({
    businessUnitId,
    stage,
    lifecycle,
    search,
    page = 1,
    pageSize = 50,
} = {}) => {
    const where = { businessUnitId: parseId(businessUnitId, "business unit id") };
    if (stage) {
        const parsed = Number(stage);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 9)
            throw httpError(400, "stage must be 1–9");
        where.stage = parsed;
    }
    if (lifecycle) where.lifecycle = lifecycle;
    if (search && String(search).trim()) {
        const term = `%${String(search).trim()}%`;
        where[Op.or] = [
            { number: { [Op.iLike]: term } },
            { customerLegalName: { [Op.iLike]: term } },
            { customerTradingName: { [Op.iLike]: term } },
        ];
    }

    const limit = Math.min(Math.max(Number(pageSize) || 50, 1), 200);
    const currentPage = Math.max(Number(page) || 1, 1);
    const { rows, count } = await Opportunity.findAndCountAll({
        where,
        order: [["updatedAt", "DESC"]],
        limit,
        offset: (currentPage - 1) * limit,
    });
    return { rows, total: count, page: currentPage, pageSize: limit };
};

// The detail payload: the record, its people, and its documents (with the
// download URL each — see leadAttachmentService.presentDocument).
export const getOpportunity = async (id) => {
    const opportunity = await Opportunity.findByPk(parseId(id, "opportunity id"), {
        include: [
            { model: Referrer, as: "referrer", attributes: ["id", "organisation"] },
            { model: User, as: "leadOwner", attributes: ["id", "name"] },
            { model: User, as: "estimator", attributes: ["id", "name"] },
            { model: User, as: "salesperson", attributes: ["id", "name"] },
            { model: User, as: "operationalCoordinator", attributes: ["id", "name"] },
            { model: User, as: "siteVisitAssignee", attributes: ["id", "name"] },
            {
                model: Document,
                as: "documents",
                include: [{ model: User, as: "uploader", attributes: ["id", "name"] }],
            },
        ],
        order: [[{ model: Document, as: "documents" }, "createdAt", "DESC"]],
    });
    if (!opportunity) throw httpError(404, "Opportunity not found");
    const plain = opportunity.get({ plain: true });
    plain.documents = (plain.documents || []).map(presentDocument);
    return plain;
};

// ---- Qualification gate -----------------------------------------------------
// A lead is marked "qualified" through the Potential-client decision, which
// the form only offers once the mandatory checklist is complete. The same
// checklist is enforced here so the API cannot be bypassed.

const isBlank = (value) => value === undefined || value === null || String(value).trim() === "";

/**
 * What the checklist still needs. `billDocument` = an energy bill is on file;
 * `skipBills` for brand-new records whose bills are uploaded right after.
 */
export const qualificationChecklistItems = (o, { billDocument = false, skipBills = false } = {}) => {
    const missing = [];
    if (o.needsClientContact && !(Array.isArray(o.contactAttempts) ? o.contactAttempts : []).length)
        missing.push("a logged contact attempt");
    if (isBlank(o.leadType)) missing.push("lead type");
    if (isBlank(o.siteLine1) || isBlank(o.siteSuburb) || isBlank(o.sitePostcode)) missing.push("site address");
    if (isBlank(o.customerEmail)) missing.push("customer email");
    if (isBlank(o.customerPhone)) missing.push("customer phone");
    if (!skipBills && !o.energyHasBills && !billDocument) missing.push("electricity bills");
    if (isBlank(o.energyAnnualKwh)) missing.push("annual usage");
    if (isBlank(o.leadSource) || (MANUAL_LEAD_SOURCES.includes(o.leadSource) && isBlank(o.leadSourceDetails)))
        missing.push("lead source details");
    return missing;
};

const assertCanQualify = async (merged, { isNew = false } = {}) => {
    const billDocument = isNew ? false : await hasDocumentOfType(merged.id, "energy_bill");
    const missing = qualificationChecklistItems(merged, { billDocument, skipBills: isNew });
    if (missing.length)
        throw httpError(
            400,
            `Complete the lead checklist before marking this a potential client — missing: ${missing.join(", ")}`
        );
};

const assertQualificationConsistent = (fields) => {
    if (fields.qualification === "disqualified" && isBlank(fields.notPotentialReason))
        throw httpError(400, "Give the reason this is not a potential client (notPotentialReason)");
    if (fields.qualification !== undefined && fields.qualification !== "disqualified") fields.notPotentialReason = null;
};

export const createLead = async (payload = {}, actor) => {
    const unit = await BusinessUnit.findByPk(parseId(payload.businessUnitId, "business unit id"));
    if (!unit) throw httpError(404, "Business unit not found");

    const fields = pickLeadFields(payload);
    if (!fields.customerLegalName?.trim()) throw httpError(400, "customerLegalName is required");
    fields.qualification = fields.qualification ?? "nurture";
    if (fields.qualification === "qualified") await assertCanQualify(fields, { isNew: true });
    assertQualificationConsistent(fields);
    fields.leadSource = fields.leadSource ?? "inbound";
    await normalizeSource(fields);
    fields.estimatorId = await assertUserExists(fields.estimatorId, "estimator");
    fields.salespersonId = await assertUserExists(fields.salespersonId, "salesperson");

    const slaDays = Number(unit.slaDays?.[1] ?? 3);
    const now = new Date();
    // Lock, number and insert in one transaction so concurrent creates in the
    // same unit queue up and each gets a distinct number.
    const opportunity = await sequelize.transaction(async (transaction) => {
        await lockNumbering(unit, transaction);
        return Opportunity.create(
            {
                ...fields,
                number: await nextNumber(unit, transaction),
                businessUnitId: unit.id,
                stage: 1,
                lifecycle: "Active",
                marginFloor: unit.marginFloor,
                leadOwnerId: actor?.id ?? null,
                slaStartedAt: now,
                slaDueAt: new Date(now.getTime() + slaDays * 86400000),
            },
            { transaction }
        );
    });
    return getOpportunity(opportunity.id);
};

// Lead details stay editable after the record moves on (matching the
// prototype); stage progression itself will be a separate, guarded action.
export const updateLead = async (id, payload = {}, actor) => {
    const opportunity = await Opportunity.findByPk(parseId(id, "opportunity id"));
    if (!opportunity) throw httpError(404, "Opportunity not found");

    const fields = pickLeadFields(payload);
    if (fields.customerLegalName !== undefined && !fields.customerLegalName?.trim())
        throw httpError(400, "customerLegalName cannot be blank");
    if (fields.qualification === "qualified" && opportunity.qualification !== "qualified")
        await assertCanQualify({ ...opportunity.get({ plain: true }), ...fields });
    assertQualificationConsistent(fields);
    fields.leadSource = fields.leadSource ?? opportunity.leadSource;
    await normalizeSource(fields);
    if (fields.estimatorId !== undefined)
        fields.estimatorId = await assertUserExists(fields.estimatorId, "estimator");
    if (fields.salespersonId !== undefined)
        fields.salespersonId = await assertUserExists(fields.salespersonId, "salesperson");
    if (payload.lifecycle !== undefined) fields.lifecycle = payload.lifecycle; // model validates the value
    const lifecycleWas = opportunity.lifecycle;

    await opportunity.update(fields);

    // Closing a record (won, lost, or closed out) is news for everyone working
    // on it — a field edit is not.
    if (fields.lifecycle && fields.lifecycle !== lifecycleWas && fields.lifecycle !== "Active")
        await notify({
            event: "lifecycle.changed",
            title: `${opportunity.number} marked ${fields.lifecycle.toLowerCase()}`,
            body: `${customerLabel(opportunity)} — ${lifecycleWas.toLowerCase()} → ${fields.lifecycle.toLowerCase()}${actor?.name ? ` by ${actor.name}` : ""}.`,
            userIds: assignedUserIds(opportunity),
            opportunity,
            actor,
        });

    return getOpportunity(opportunity.id);
};

// Move to the next stage the unit runs (disabled stages are skipped, never
// renumbered) and restart the SLA clock from the unit's slaDays config.
// Stage gates live here — leaving lead capture needs a potential (qualified)
// lead with an estimator.
export const advanceStage = async (id, actor) => {
    const opportunity = await Opportunity.findByPk(parseId(id, "opportunity id"));
    if (!opportunity) throw httpError(404, "Opportunity not found");
    if (opportunity.lifecycle !== "Active")
        throw httpError(400, "Only active records can advance");
    if (opportunity.stage >= 9) throw httpError(400, "Already at the final stage");
    if (opportunity.stage === 1) {
        if (opportunity.qualification !== "qualified")
            throw httpError(400, "Lead must be marked a potential client to progress");
        if (!opportunity.estimatorId)
            throw httpError(400, "Assign an estimator before leaving lead capture");
    }
    // Leaving estimation needs sales' requirements confirmed, no client input
    // outstanding, and a quote with at least one priced item.
    if (opportunity.stage === 2) {
        if (!isEstimationReady(opportunity))
            throw httpError(400, "Complete estimation (requirements confirmed, client input resolved) before leaving this stage");
        if (!(await quoteHasItems(opportunity.id)))
            throw httpError(400, "Add at least one item to the quote before leaving estimation");
    }

    const unit = await BusinessUnit.findByPk(opportunity.businessUnitId);
    const enabled = (Array.isArray(unit?.enabledStages) ? unit.enabledStages : []).map(Number);
    let next = opportunity.stage + 1;
    while (next <= 9 && enabled.length && !enabled.includes(next)) next += 1;
    if (next > 9) throw httpError(400, "No further stage is enabled for this business unit");

    const slaDays = Number(unit?.slaDays?.[next] ?? 0);
    const now = new Date();
    const from = opportunity.stage;
    await opportunity.update({
        stage: next,
        slaStartedAt: now,
        slaDueAt: slaDays ? new Date(now.getTime() + slaDays * 86400000) : null,
    });

    await notify({
        event: "stage.advanced",
        title: `${opportunity.number} moved to stage ${next}`,
        body: `${customerLabel(opportunity)} — stage ${from} → ${next}${actor?.name ? `, moved by ${actor.name}` : ""}.`,
        userIds: assignedUserIds(opportunity),
        opportunity,
        actor,
    });

    return getOpportunity(opportunity.id);
};

// Only records still at the lead stage can be removed; anything further has
// downstream history (estimates, approvals) that must not vanish.
export const deleteLead = async (id, actor) => {
    const opportunity = await Opportunity.findByPk(parseId(id, "opportunity id"));
    if (!opportunity) throw httpError(404, "Opportunity not found");
    if (opportunity.stage > 1)
        throw httpError(400, "Only records still at the lead stage can be deleted");
    await opportunity.destroy(); // paranoid — soft delete
};
