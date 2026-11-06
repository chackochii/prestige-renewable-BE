// The lead inbox: automated leads from the ad platforms, filed as they
// arrive and reviewed by sales.
//
// ingestLead() is the one way a lead gets in — the webhooks and the Meta poll
// both call it. It is idempotent on (source, externalLeadId), so a platform
// re-sending a lead (Meta retries, the poll overlapping the webhook) is a
// no-op; it flags a lead that matches an earlier one's email or phone rather
// than dropping it; it tells the sales managers; and when the connection says
// so it converts the lead straight away.
//
// Converting makes a normal stage-1 opportunity through createLead — numbering,
// SLA and the business-owner notification all as for a hand-typed lead — with
// leadSource set to the platform and inboundLeadId pointing back here, so
// campaign attribution is one join away. Rejecting keeps the row with the
// reason; a rejected lead can be reopened.
import { Op } from "sequelize";
import db from "../../../models/index.js";
import { parseId } from "../../../utils/ids.js";
import { pagingOf } from "../../../utils/pagination.js";
import { canAccessUnit } from "../../../utils/unitScope.js";
import { multiLine } from "../../../utils/text.js";
import { open as openSecret } from "../../../utils/secretBox.js";
import logger from "../../../utils/logger.js";
import { notify } from "../../notification/service/notificationService.js";
import { createLead } from "../../opportunity/service/opportunityService.js";
import { BUSINESS_OWNER_ROLE, SALES_MANAGER_ROLE, notifyBusinessOwner, recordSystemEvent } from "../../opportunity/service/leadWorkflowService.js";
import { LEAD_PLATFORMS, PLATFORM_LABELS } from "../model/integrationConnection.js";
import { INBOUND_LEAD_STATUSES } from "../model/inboundLead.js";
import { displayName, normalizeFields, phoneKey } from "./leadNormalizer.js";
import { fetchLead } from "./metaGraph.js";
import { metaFormName, metaLeadInput } from "./platformLeads.js";

const { InboundLead, IntegrationConnection, Opportunity, User, sequelize } = db;

const httpError = (status, message) => Object.assign(new Error(message), { status });

const AU_STATES = ["NSW", "ACT", "VIC", "QLD", "SA", "WA", "TAS", "NT"];

export const sourceLabel = (source) => PLATFORM_LABELS[source] ?? source;

// ---- Presenting -------------------------------------------------------------

const includes = () => [
    { model: IntegrationConnection, as: "connection", attributes: ["id", "name", "platform"] },
    { model: Opportunity, as: "opportunity", attributes: ["id", "number", "stage", "lifecycle"] },
    { model: InboundLead, as: "duplicateOf", attributes: ["id", "name", "email", "phone", "status", "opportunityId", "receivedAt"] },
    { model: User, as: "reviewedBy", attributes: ["id", "name"] },
];

/** Public shape of an inbox row. `detail` adds the answers and the raw payload. */
export const presentInboundLead = (row, { detail = false } = {}) => {
    const plain = typeof row.get === "function" ? row.get({ plain: true }) : { ...row };
    const normalized = plain.payload?.normalized ?? {};
    const out = {
        id: plain.id,
        connectionId: plain.connectionId ?? null,
        connectionName: plain.connection?.name ?? null,
        businessUnitId: plain.businessUnitId,
        source: plain.source,
        sourceLabel: sourceLabel(plain.source),
        externalLeadId: plain.externalLeadId ?? null,
        status: plain.status,
        displayName: displayName({ name: plain.name, company: plain.company, email: plain.email, phone: plain.phone }),
        name: plain.name ?? null,
        email: plain.email ?? null,
        phone: plain.phone ?? null,
        company: plain.company ?? null,
        suburb: plain.suburb ?? null,
        postcode: plain.postcode ?? null,
        message: plain.message ?? null,
        campaignId: plain.campaignId ?? null,
        campaignName: plain.campaignName ?? null,
        adGroupId: plain.adGroupId ?? null,
        adGroupName: plain.adGroupName ?? null,
        adId: plain.adId ?? null,
        adName: plain.adName ?? null,
        formId: plain.formId ?? null,
        formName: plain.formName ?? null,
        isTest: Boolean(plain.payload?.isTest),
        fetchError: plain.fetchError ?? null,
        duplicateOfId: plain.duplicateOfId ?? null,
        duplicateOf: plain.duplicateOf
            ? {
                  id: plain.duplicateOf.id,
                  displayName: displayName(plain.duplicateOf),
                  status: plain.duplicateOf.status,
                  opportunityId: plain.duplicateOf.opportunityId ?? null,
                  receivedAt: plain.duplicateOf.receivedAt,
              }
            : null,
        opportunityId: plain.opportunityId ?? null,
        opportunity: plain.opportunity
            ? { id: plain.opportunity.id, number: plain.opportunity.number, stage: plain.opportunity.stage, lifecycle: plain.opportunity.lifecycle }
            : null,
        reviewedById: plain.reviewedById ?? null,
        reviewedByName: plain.reviewedBy?.name ?? null,
        reviewedAt: plain.reviewedAt ?? null,
        rejectReason: plain.rejectReason ?? null,
        receivedAt: plain.receivedAt,
        createdAt: plain.createdAt,
    };
    if (detail) {
        out.street = normalized.street || null;
        out.state = normalized.state || null;
        out.firstName = normalized.firstName || null;
        out.lastName = normalized.lastName || null;
        out.extras = Array.isArray(normalized.extras) ? normalized.extras : [];
        out.payload = plain.payload?.raw ?? null;
    }
    return out;
};

const loadLead = async (id, { include = true } = {}) => {
    const lead = await InboundLead.findByPk(parseId(id, "inbound lead id"), include ? { include: includes() } : {});
    if (!lead) throw httpError(404, "Inbound lead not found");
    return lead;
};

// Out-of-scope reads answer "not found", as the opportunity routes do, so a
// caller cannot probe which ids exist in other units.
const loadForActor = async (id, actor) => {
    const lead = await loadLead(id);
    if (actor && !canAccessUnit(actor, lead.businessUnitId)) throw httpError(404, "Inbound lead not found");
    return lead;
};

// ---- Duplicates -------------------------------------------------------------

const contactMatch = (lead) => {
    const or = [];
    if (lead.email) or.push({ email: lead.email });
    const key = phoneKey(lead.phone);
    if (key) or.push({ phone: { [Op.like]: `%${key}` } });
    return or;
};

/** Points the lead at the earliest one in its unit with the same email or phone, if any. */
const flagDuplicate = async (lead) => {
    const or = contactMatch(lead);
    if (!or.length) return null;
    const earlier = await InboundLead.findOne({
        where: { businessUnitId: lead.businessUnitId, id: { [Op.ne]: lead.id }, [Op.or]: or },
        order: [["receivedAt", "ASC"], ["id", "ASC"]],
        attributes: ["id"],
    });
    await lead.update({ duplicateOfId: earlier?.id ?? null });
    return earlier?.id ?? null;
};

/** Opportunities in the unit already carrying this email or phone — shown to the reviewer before they convert. */
export const matchingOpportunities = async (lead) => {
    const or = [];
    if (lead.email) or.push({ customerEmail: lead.email }, { contactEmail: lead.email });
    const key = phoneKey(lead.phone);
    if (key)
        for (const column of ["customer_phone", "contact_phone"])
            or.push(sequelize.where(sequelize.fn("regexp_replace", sequelize.col(column), "\\D", "", "g"), { [Op.like]: `%${key}` }));
    if (!or.length) return [];
    const rows = await Opportunity.findAll({
        where: { businessUnitId: lead.businessUnitId, [Op.or]: or },
        attributes: ["id", "number", "stage", "lifecycle", "customerLegalName", "createdAt"],
        order: [["createdAt", "DESC"]],
        limit: 5,
    });
    return rows.map((row) => ({
        id: row.id,
        number: row.number,
        stage: row.stage,
        lifecycle: row.lifecycle,
        customerLegalName: row.customerLegalName,
        createdAt: row.createdAt,
    }));
};

// ---- Ingest -----------------------------------------------------------------

const columnsOf = (normalized, attribution = {}) => ({
    name: normalized.name || null,
    email: normalized.email || null,
    phone: normalized.phone || null,
    company: normalized.company || null,
    suburb: normalized.suburb || null,
    postcode: normalized.postcode || null,
    message: normalized.message || null,
    campaignId: attribution.campaignId ?? null,
    campaignName: attribution.campaignName ?? null,
    adGroupId: attribution.adGroupId ?? null,
    adGroupName: attribution.adGroupName ?? null,
    adId: attribution.adId ?? null,
    adName: attribution.adName ?? null,
    formId: attribution.formId ?? null,
    formName: attribution.formName ?? null,
});

const tellSales = async (lead) => {
    const label = sourceLabel(lead.source);
    const contact = [lead.phone, lead.email].filter(Boolean).join(" · ") || "no contact details";
    const campaign = lead.campaignName ? ` · ${lead.campaignName}` : "";
    const notice = {
        event: "lead.inbound",
        title: `New ${label} lead: ${displayName(lead)}`,
        body: `${contact}${campaign} — waiting in the lead inbox${lead.duplicateOfId ? " (matches an earlier lead)" : ""}.`,
        businessUnitId: lead.businessUnitId,
        dedupeKey: `inbound:${lead.id}`,
    };
    // Both roles; a person holding both gets one notice (the dedupe key).
    await notify({ ...notice, roleCode: SALES_MANAGER_ROLE });
    await notify({ ...notice, roleCode: BUSINESS_OWNER_ROLE });
};

/**
 * Files one lead under a connection. input is what platformLeads produces:
 * { externalLeadId, fields, attribution, raw, receivedAt?, isTest?, fetchError? }.
 * → { lead, created, converted }: created=false when the platform's lead id was
 * already filed (then a stub whose answers failed to fetch earlier is filled in).
 */
export const ingestLead = async (connection, input) => {
    const normalized = normalizeFields(input.fields, { fieldMap: connection.config?.fieldMap });
    const payload = { raw: input.raw ?? {}, normalized, isTest: Boolean(input.isTest), fetchedAt: new Date().toISOString() };
    const values = {
        connectionId: connection.id,
        businessUnitId: connection.businessUnitId,
        source: connection.platform,
        externalLeadId: input.externalLeadId || null,
        status: "pending",
        payload,
        fetchError: input.fetchError ?? null,
        receivedAt: input.receivedAt ?? new Date(),
        ...columnsOf(normalized, input.attribution),
    };

    let lead;
    let created = true;
    try {
        lead = await InboundLead.create(values);
    } catch (err) {
        if (err.name !== "SequelizeUniqueConstraintError" || !values.externalLeadId) throw err;
        created = false;
        lead = await InboundLead.findOne({ where: { source: values.source, externalLeadId: values.externalLeadId } });
        if (!lead) throw err;
        // Filed as a stub when its answers could not be fetched: now they can.
        if (lead.fetchError && !input.fetchError && lead.status === "pending") {
            await lead.update({ payload, fetchError: null, ...columnsOf(normalized, input.attribution) });
            await flagDuplicate(lead);
            await tellSales(lead);
        }
    }

    await IntegrationConnection.update({ lastEventAt: new Date() }, { where: { id: connection.id } });
    if (!created) return { lead, created: false, converted: false };

    await flagDuplicate(lead);

    let converted = false;
    if (connection.autoConvert && !lead.fetchError) {
        try {
            await convertInboundLead(lead.id, {}, null);
            converted = true;
        } catch (err) {
            logger.warn(`Inbound lead ${lead.id}: automatic conversion failed, left in the inbox — ${err.message}`);
        }
    }
    if (!converted) {
        try {
            await tellSales(lead);
        } catch (err) {
            logger.warn(`Inbound lead ${lead.id}: notification failed — ${err.message}`);
        }
    }
    return { lead, created: true, converted };
};

// ---- Reading ----------------------------------------------------------------

const countsFor = async (businessUnitId) => {
    const rows = await InboundLead.findAll({
        where: { businessUnitId },
        attributes: ["status", [sequelize.fn("COUNT", sequelize.col("id")), "count"]],
        group: ["status"],
        raw: true,
    });
    const counts = Object.fromEntries(INBOUND_LEAD_STATUSES.map((status) => [status, 0]));
    for (const row of rows) counts[row.status] = Number(row.count);
    return counts;
};

/**
 * ?businessUnitId= (required) &status=pending|converted|rejected &source=
 * &search= &page= &pageSize= → { rows, total, page, pageSize, counts }, newest first.
 */
export const listInboundLeads = async (query = {}) => {
    const businessUnitId = parseId(query.businessUnitId, "business unit id");
    const where = { businessUnitId };
    if (query.status) {
        if (!INBOUND_LEAD_STATUSES.includes(String(query.status))) throw httpError(400, `status must be one of: ${INBOUND_LEAD_STATUSES.join(", ")}`);
        where.status = String(query.status);
    }
    if (query.source) {
        if (!LEAD_PLATFORMS.includes(String(query.source))) throw httpError(400, `source must be one of: ${LEAD_PLATFORMS.join(", ")}`);
        where.source = String(query.source);
    }
    if (query.search && String(query.search).trim()) {
        const term = `%${String(query.search).trim().replace(/[\\%_]/g, "\\$&")}%`;
        where[Op.or] = ["name", "email", "phone", "company", "suburb", "campaignName", "formName"].map((field) => ({ [field]: { [Op.iLike]: term } }));
    }

    const paging = pagingOf(query);
    const [{ rows, count }, counts] = await Promise.all([
        InboundLead.findAndCountAll({
            where,
            include: includes(),
            order: [["receivedAt", "DESC"], ["id", "DESC"]],
            limit: paging.limit,
            offset: paging.offset,
            distinct: true,
        }),
        countsFor(businessUnitId),
    ]);
    return { rows: rows.map((row) => presentInboundLead(row)), total: count, page: paging.page, pageSize: paging.pageSize, counts };
};

/** One lead with its answers, plus the opportunities already holding its email or phone. */
export const getInboundLead = async (id, actor) => {
    const lead = await loadForActor(id, actor);
    return { ...presentInboundLead(lead, { detail: true }), matches: await matchingOpportunities(lead) };
};

// ---- Review -----------------------------------------------------------------

// Fields the reviewer may set on the opportunity being created, on top of
// what the lead carries. The unit and the source are never theirs to choose.
const BLOCKED_OVERRIDES = ["businessUnitId", "leadSource", "referrerId", "referrerName", "involvementTier"];

/**
 * Makes a stage-1 opportunity from the lead. body: { overrides?: { …lead fields } }
 * → { lead, opportunity }. actor null = the connection's auto-convert.
 */
export const convertInboundLead = async (id, body = {}, actor) => {
    const lead = await loadForActor(id, actor);
    if (lead.status === "converted")
        throw httpError(409, `This lead was already converted${lead.opportunity ? ` as ${lead.opportunity.number}` : ""}`);
    if (lead.fetchError && !lead.name && !lead.email && !lead.phone)
        throw httpError(409, "This lead's answers have not been fetched from the platform yet — refresh it first");

    const normalized = lead.payload?.normalized ?? {};
    const label = sourceLabel(lead.source);
    const sourceDetails = [
        label,
        lead.campaignName || (lead.campaignId ? `campaign ${lead.campaignId}` : null),
        lead.formName || (lead.formId ? `form ${lead.formId}` : null),
        lead.payload?.isTest ? "test lead" : null,
    ]
        .filter(Boolean)
        .join(" · ");

    const overrides = body?.overrides && typeof body.overrides === "object" && !Array.isArray(body.overrides) ? { ...body.overrides } : {};
    for (const key of BLOCKED_OVERRIDES) delete overrides[key];

    const payload = {
        customerLegalName: displayName(lead),
        customerTradingName: lead.company || null,
        customerEmail: lead.email || null,
        customerPhone: lead.phone || null,
        contactName: lead.name || null,
        contactEmail: lead.email || null,
        contactPhone: lead.phone || null,
        siteLine1: normalized.street || null,
        siteSuburb: lead.suburb || null,
        siteState: AU_STATES.includes(normalized.state) ? normalized.state : null,
        sitePostcode: lead.postcode || null,
        leadSourceDetails: sourceDetails.slice(0, 500),
        notes: lead.message || null,
        ...overrides,
        businessUnitId: lead.businessUnitId,
    };

    const opportunity = await createLead(payload, actor, { inbound: { id: lead.id, source: lead.source } });
    await lead.update({ status: "converted", opportunityId: opportunity.id, reviewedById: actor?.id ?? null, reviewedAt: new Date(), rejectReason: null });

    const how = actor ? "" : " automatically";
    const about = [lead.campaignName, lead.formName].filter(Boolean).join(" · ");
    await recordSystemEvent(opportunity, `Converted${how} from ${label} lead #${lead.id}${about ? ` (${about})` : ""}`, actor);
    try {
        await notifyBusinessOwner(opportunity.id, actor);
    } catch (err) {
        logger.warn(`Inbound lead ${lead.id}: business owner notification failed — ${err.message}`);
    }
    return { lead: presentInboundLead(await loadLead(lead.id)), opportunity };
};

/** { reason? } → the lead, rejected. A converted lead cannot be rejected. */
export const rejectInboundLead = async (id, body = {}, actor) => {
    const lead = await loadForActor(id, actor);
    if (lead.status === "converted") throw httpError(409, "This lead was already converted — close the opportunity instead");
    const reason = multiLine(body.reason, 2000) || null;
    await lead.update({ status: "rejected", rejectReason: reason, reviewedById: actor?.id ?? null, reviewedAt: new Date() });
    return presentInboundLead(await loadLead(lead.id));
};

/** A rejected lead back into the queue. */
export const reopenInboundLead = async (id, actor) => {
    const lead = await loadForActor(id, actor);
    if (lead.status !== "rejected") throw httpError(409, "Only a rejected lead can be reopened");
    await lead.update({ status: "pending", rejectReason: null, reviewedById: null, reviewedAt: null });
    return presentInboundLead(await loadLead(lead.id));
};

/**
 * Fetches a Meta lead's answers again (a stub whose fetch failed, or a
 * mapping that changed since). Needs the connection and its page token.
 */
export const refreshInboundLead = async (id, actor) => {
    const lead = await loadForActor(id, actor);
    if (lead.source !== "meta_ads") throw httpError(400, "Only Meta leads can be refreshed from the platform");
    if (!lead.externalLeadId) throw httpError(400, "This lead has no platform id to fetch");
    const connection = lead.connectionId ? await IntegrationConnection.findByPk(lead.connectionId) : null;
    if (!connection) throw httpError(409, "The connection this lead came through no longer exists");
    const token = openSecret(connection.credentials?.pageAccessToken);
    if (!token) throw httpError(409, "The connection has no page access token");

    let raw;
    try {
        raw = await fetchLead(lead.externalLeadId, token);
    } catch (err) {
        await lead.update({ fetchError: err.message });
        await connection.update({ lastError: err.message, lastErrorAt: new Date() });
        throw httpError(err.status === 401 ? 409 : 502, err.message);
    }
    const input = metaLeadInput(raw, { formName: await metaFormName(raw.form_id, token), webhook: lead.payload?.raw?.webhook ?? null });
    const normalized = normalizeFields(input.fields, { fieldMap: connection.config?.fieldMap });
    await lead.update({
        payload: { raw: input.raw, normalized, isTest: false, fetchedAt: new Date().toISOString() },
        fetchError: null,
        receivedAt: input.receivedAt ?? lead.receivedAt,
        ...columnsOf(normalized, input.attribution),
    });
    await connection.update({ lastError: null, lastErrorAt: null });
    await flagDuplicate(lead);
    return presentInboundLead(await loadLead(lead.id));
};
