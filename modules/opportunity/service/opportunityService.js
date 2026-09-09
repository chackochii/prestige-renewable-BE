// Lead-stage CRUD for opportunities. A "lead" is an opportunity at stage 1;
// creating one snapshots the unit's margin floor and starts the stage-1 SLA
// clock from the unit's slaDays config. Later stages get their own services
// as the pipeline modules ship.
import { Op } from "sequelize";
import db from "../../../models/index.js";
import { parseId } from "../../../utils/ids.js";
import { presentDocument, qualificationGateItems } from "./leadAttachmentService.js";

const { Opportunity, BusinessUnit, Referrer, User, Document } = db;

const httpError = (status, message) => Object.assign(new Error(message), { status });

// Sources a person can pick on the form. The ad/ServiceM8 sources are set by
// inbound-lead conversion only, never by hand.
const MANUAL_LEAD_SOURCES = ["internal", "inbound", "referrer"];

// Fields the client may set directly; everything else (number, stage,
// lifecycle, SLA, margin floor, owners' audit trail) is server-managed.
const LEAD_FIELDS = [
    "customerLegalName", "customerTradingName", "customerAbn", "customerEmail",
    "customerPhone", "customerBillingAddress",
    "siteLine1", "siteSuburb", "siteState", "sitePostcode", "siteJurisdiction",
    "siteContact", "siteAccessNotes",
    "contactName", "contactRole", "contactEmail", "contactPhone",
    "qualification", "qualificationAuthority", "qualificationTiming",
    "estimatedValue", "nextAction", "nextActionDueAt",
    "energyAnnualKwh", "energyHasBills", "energyNotes",
    "leadSource", "referrerId", "involvementTier", "leadType",
    "estimatorId", "salespersonId", "notes",
];

const pickLeadFields = (payload) => {
    const picked = {};
    for (const field of LEAD_FIELDS) if (payload[field] !== undefined) picked[field] = payload[field];
    if (picked.energyHasBills !== undefined) picked.energyHasBills = Boolean(picked.energyHasBills);
    if (picked.leadType === "") picked.leadType = null; // model validates the value otherwise
    for (const numeric of ["energyAnnualKwh", "estimatedValue"]) {
        if (picked[numeric] === "" || picked[numeric] === null) picked[numeric] = null;
        else if (picked[numeric] !== undefined && !Number.isFinite(Number(picked[numeric])))
            throw httpError(400, `${numeric} must be a number`);
    }
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

// PRS-26-0042: unit code, two-digit year, sequence. Soft-deleted rows keep
// their number, so the scan is unscoped by paranoid to avoid reuse.
const nextNumber = async (unit) => {
    const year = String(new Date().getFullYear()).slice(-2);
    const prefix = `${unit.code}-${year}-`;
    const last = await Opportunity.findOne({
        where: { number: { [Op.like]: `${prefix}%` } },
        order: [["number", "DESC"]],
        paranoid: false,
    });
    const sequence = last ? Number(last.number.slice(prefix.length)) + 1 : 1;
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

// Marking a lead Qualified needs evidence from the ground: a logged client
// meeting and a site photo or sketch (the prototype's rule). New leads
// therefore start as Nurture unless the caller says otherwise — and cannot
// start Qualified.
const assertCanQualify = async (opportunity) => {
    const missing = await qualificationGateItems(opportunity);
    if (missing.length)
        throw httpError(
            400,
            `Before marking the lead Qualified, add ${missing.join(" and ")} on the record`
        );
};

export const createLead = async (payload = {}, actor) => {
    const unit = await BusinessUnit.findByPk(parseId(payload.businessUnitId, "business unit id"));
    if (!unit) throw httpError(404, "Business unit not found");

    const fields = pickLeadFields(payload);
    if (!fields.customerLegalName?.trim()) throw httpError(400, "customerLegalName is required");
    fields.qualification = fields.qualification ?? "nurture";
    if (fields.qualification === "qualified")
        throw httpError(
            400,
            "A new lead starts as Nurture — log a client meeting and attach a site photo or sketch on the record before marking it Qualified"
        );
    fields.leadSource = fields.leadSource ?? "inbound";
    await normalizeSource(fields);
    fields.estimatorId = await assertUserExists(fields.estimatorId, "estimator");
    fields.salespersonId = await assertUserExists(fields.salespersonId, "salesperson");

    const slaDays = Number(unit.slaDays?.[1] ?? 3);
    const now = new Date();
    const opportunity = await Opportunity.create({
        ...fields,
        number: await nextNumber(unit),
        businessUnitId: unit.id,
        stage: 1,
        lifecycle: "Active",
        marginFloor: unit.marginFloor,
        leadOwnerId: actor?.id ?? null,
        slaStartedAt: now,
        slaDueAt: new Date(now.getTime() + slaDays * 86400000),
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
        await assertCanQualify(opportunity);
    fields.leadSource = fields.leadSource ?? opportunity.leadSource;
    await normalizeSource(fields);
    if (fields.estimatorId !== undefined)
        fields.estimatorId = await assertUserExists(fields.estimatorId, "estimator");
    if (fields.salespersonId !== undefined)
        fields.salespersonId = await assertUserExists(fields.salespersonId, "salesperson");
    if (payload.lifecycle !== undefined) fields.lifecycle = payload.lifecycle; // model validates the value

    await opportunity.update(fields);
    return getOpportunity(opportunity.id);
};

// Move to the next stage the unit runs (disabled stages are skipped, never
// renumbered) and restart the SLA clock from the unit's slaDays config.
// Stage gates live here — leaving lead capture needs a qualified lead with
// an estimator, matching the prototype's rule.
export const advanceStage = async (id, actor) => {
    const opportunity = await Opportunity.findByPk(parseId(id, "opportunity id"));
    if (!opportunity) throw httpError(404, "Opportunity not found");
    if (opportunity.lifecycle !== "Active")
        throw httpError(400, "Only active records can advance");
    if (opportunity.stage >= 9) throw httpError(400, "Already at the final stage");
    if (opportunity.stage === 1) {
        if (opportunity.qualification !== "qualified")
            throw httpError(400, "Lead must be Qualified to progress (or mark it Lost / Nurture)");
        if (!opportunity.estimatorId)
            throw httpError(400, "Assign an estimator before leaving lead capture");
    }

    const unit = await BusinessUnit.findByPk(opportunity.businessUnitId);
    const enabled = (Array.isArray(unit?.enabledStages) ? unit.enabledStages : []).map(Number);
    let next = opportunity.stage + 1;
    while (next <= 9 && enabled.length && !enabled.includes(next)) next += 1;
    if (next > 9) throw httpError(400, "No further stage is enabled for this business unit");

    const slaDays = Number(unit?.slaDays?.[next] ?? 0);
    const now = new Date();
    await opportunity.update({
        stage: next,
        slaStartedAt: now,
        slaDueAt: slaDays ? new Date(now.getTime() + slaDays * 86400000) : null,
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
