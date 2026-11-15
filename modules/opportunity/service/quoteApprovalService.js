// Quote approval: a Senior Sales Representative signs off every quotation
// before it goes to the customer.
//
//   1. Sales prepares the quote (a generated quote version) and submits it:
//      POST /:id/quote-approvals { quoteVersionId?, note? } → pending, or
//      resubmitted when an earlier submission on the job was rejected.
//   2. An approver (quotes.approve — Senior Sales Representative, Sales &
//      Marketing Manager, Business Owner; ADM) reviews the pricing, products,
//      system configuration and additional charges and decides:
//      POST /:id/quote-approvals/:approvalId/decision { outcome, comments }.
//      A rejection needs comments; nobody approves their own submission.
//   3. Once approved the version may be sent (proposalService.sendProposal
//      calls assertQuoteApprovedForSending).
//
// The restriction is switched on per business unit (metadata
// .quoteApprovalRequired = true) or for every unit (QUOTE_APPROVAL_REQUIRED=true).
// While it is off, the workflow runs but sending is not blocked, so the
// current screens keep working until the approval screens ship.
import { Op } from "sequelize";
import db from "../../../models/index.js";
import { parseId } from "../../../utils/ids.js";
import { pagingOf } from "../../../utils/pagination.js";
import { multiLine } from "../../../utils/text.js";
import { assertUnitAccess, unitScopeOf } from "../../../utils/unitScope.js";
import { usersWithPermissionIn } from "../../../utils/permissionHolders.js";
import { SUPER_ROLE_CODE, userHasPermission } from "../../role/service/roleService.js";
import { notify } from "../../notification/service/notificationService.js";
import { recordActivity } from "../../activity/service/activityService.js";
import { recordSystemEvent } from "./leadWorkflowService.js";
import { customerLabel } from "./opportunityPeople.js";
import { AWAITING_STATUSES, QUOTE_APPROVAL_STATUSES } from "../model/quoteApproval.js";

const { QuoteApproval, QuoteVersion, Opportunity, BusinessUnit, User } = db;

const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

export const APPROVE_PERMISSION = "quotes.approve";

const money = (value) =>
    value === null || value === undefined ? "" : new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(Number(value));

const INCLUDE = [
    { model: QuoteVersion, as: "quoteVersion", attributes: ["id", "version", "quoteNumber", "grandTotal", "createdAt"] },
    { model: User, as: "submittedBy", attributes: ["id", "name"], paranoid: false },
    { model: User, as: "approver", attributes: ["id", "name"], paranoid: false },
    { model: Opportunity, as: "opportunity", attributes: ["id", "number", "stage", "businessUnitId", "customerLegalName", "customerTradingName", "salespersonId"] },
];

const brief = (u) => (u ? { id: u.id, name: u.name } : null);

export const presentQuoteApproval = (row) => ({
    id: row.id,
    opportunityId: row.opportunityId,
    job: row.opportunity ? { id: row.opportunity.id, number: row.opportunity.number, stage: row.opportunity.stage, customer: customerLabel(row.opportunity) } : null,
    businessUnitId: row.businessUnitId,
    quoteVersion: row.quoteVersion
        ? { id: row.quoteVersion.id, version: row.quoteVersion.version, quoteNumber: row.quoteVersion.quoteNumber, grandTotal: row.quoteVersion.grandTotal === null ? null : Number(row.quoteVersion.grandTotal) }
        : { id: row.quoteVersionId },
    round: row.round,
    status: row.status,
    awaitingDecision: AWAITING_STATUSES.includes(row.status),
    submittedBy: brief(row.submittedBy),
    submittedAt: row.submittedAt,
    submissionNote: row.submissionNote ?? null,
    approver: brief(row.approver),
    decidedAt: row.decidedAt ?? null,
    comments: row.comments ?? null,
});

/** Whether sending a quote needs an approval in this unit. */
export const approvalRequiredFor = async (businessUnitId) => {
    if (String(process.env.QUOTE_APPROVAL_REQUIRED ?? "").toLowerCase() === "true") return true;
    const unit = await BusinessUnit.findByPk(businessUnitId, { attributes: ["id", "metadata"] });
    return unit?.metadata?.quoteApprovalRequired === true;
};

/** The newest approval row for a quote version, or null. */
export const latestForVersion = (quoteVersionId) =>
    QuoteApproval.findOne({ where: { quoteVersionId }, include: INCLUDE, order: [["createdAt", "DESC"], ["id", "DESC"]] });

/** version id → its newest approval's status, for the versions list. */
export const statusByVersion = async (versionIds) => {
    if (!versionIds.length) return new Map();
    const rows = await QuoteApproval.findAll({ where: { quoteVersionId: versionIds }, attributes: ["id", "quoteVersionId", "status", "createdAt"], order: [["createdAt", "ASC"], ["id", "ASC"]] });
    const map = new Map();
    for (const row of rows) map.set(row.quoteVersionId, row.status); // the last one wins
    return map;
};

/**
 * Refuses to send a quote version that has not been approved — when the unit
 * requires approval. Called by proposalService before a proposal is made.
 */
export const assertQuoteApprovedForSending = async (opportunity, quoteVersion) => {
    if (!(await approvalRequiredFor(opportunity.businessUnitId))) return;
    const latest = await latestForVersion(quoteVersion.id);
    if (latest?.status === "approved") return;
    const state = !latest ? "has not been submitted for approval" : AWAITING_STATUSES.includes(latest.status) ? "is waiting for a Senior Sales Representative's approval" : "was rejected — make the changes and resubmit it";
    throw httpError(409, `Quote ${quoteVersion.quoteNumber || ""} v${quoteVersion.version} ${state}. Quotes need approval before they are sent to the customer.`.replace(/\s+/g, " "), {
        code: "QUOTE_APPROVAL_REQUIRED",
        details: { quoteVersionId: quoteVersion.id, approval: latest ? presentQuoteApproval(latest) : null },
    });
};

const loadOpportunity = async (id) => {
    const opportunity = await Opportunity.findByPk(parseId(id, "opportunity id"));
    if (!opportunity) throw httpError(404, "Opportunity not found");
    return opportunity;
};

/** Every submission on the job, newest first, and whether approval is required in its unit. */
export const listForOpportunity = async (id) => {
    const opportunity = await loadOpportunity(id);
    const rows = await QuoteApproval.findAll({ where: { opportunityId: opportunity.id }, include: INCLUDE, order: [["createdAt", "DESC"], ["id", "DESC"]] });
    return { required: await approvalRequiredFor(opportunity.businessUnitId), items: rows.map(presentQuoteApproval) };
};

/** The approvers' queue: ?businessUnitId=&status=&mine=1&page=&pageSize= (default: waiting on a decision). */
export const listQueue = async (query = {}, actor) => {
    const where = {};
    const scope = unitScopeOf(actor);
    if (query.businessUnitId) {
        const unitId = parseId(query.businessUnitId, "businessUnitId");
        assertUnitAccess(actor, unitId);
        where.businessUnitId = unitId;
    } else if (scope) where.businessUnitId = { [Op.in]: scope };
    if (query.status === "all") {
        // every status
    } else if (query.status) {
        if (!QUOTE_APPROVAL_STATUSES.includes(query.status)) throw httpError(400, `status must be one of: all, ${QUOTE_APPROVAL_STATUSES.join(", ")}`);
        where.status = query.status;
    } else where.status = { [Op.in]: AWAITING_STATUSES };
    if (query.mine === "1" || query.mine === "true") where.submittedById = actor.id;
    const paging = pagingOf(query, { defaultSize: 12, maxSize: 100 });
    const { rows, count } = await QuoteApproval.findAndCountAll({ where, include: INCLUDE, order: [["submittedAt", "ASC"], ["id", "ASC"]], limit: paging.limit, offset: paging.offset, distinct: true });
    return { data: rows.map(presentQuoteApproval), total: count, page: paging.page, pageSize: paging.pageSize };
};

/**
 * Sales submits a quote version for approval: { quoteVersionId?, note? }
 * (default: the newest version). Resubmitting after a rejection is the same
 * call; the row is marked resubmitted and the round goes up.
 */
export const submitForApproval = async (id, payload = {}, actor, ctx = null) => {
    const opportunity = await loadOpportunity(id);
    if (opportunity.lifecycle !== "Active") throw httpError(400, "Only an active job's quote can be submitted for approval");
    const version = payload.quoteVersionId
        ? await QuoteVersion.findOne({ where: { id: parseId(payload.quoteVersionId, "quoteVersionId"), opportunityId: opportunity.id } })
        : await QuoteVersion.findOne({ where: { opportunityId: opportunity.id }, order: [["version", "DESC"], ["id", "DESC"]] });
    if (!version) throw httpError(400, payload.quoteVersionId ? "That quote version does not belong to this job" : "Generate the quote before submitting it for approval");

    const latest = await latestForVersion(version.id);
    if (latest && AWAITING_STATUSES.includes(latest.status)) throw httpError(409, `Quote v${version.version} is already waiting for approval (submitted by ${latest.submittedBy?.name ?? "someone"})`);
    if (latest?.status === "approved") throw httpError(409, `Quote v${version.version} is already approved — it can be sent`);

    const previous = await QuoteApproval.findOne({ where: { opportunityId: opportunity.id }, order: [["round", "DESC"], ["id", "DESC"]] });
    const resubmission = Boolean(previous && previous.status === "rejected");
    const note = multiLine(payload.note, 2000) || null;
    if (resubmission && !note) throw httpError(400, "Say what was changed since the rejection (note) — the approver reviews it against their comments");

    const row = await QuoteApproval.create({
        opportunityId: opportunity.id,
        businessUnitId: opportunity.businessUnitId,
        quoteId: version.quoteId,
        quoteVersionId: version.id,
        round: (previous?.round ?? 0) + 1,
        status: resubmission ? "resubmitted" : "pending",
        submittedById: actor?.id ?? null,
        submittedAt: new Date(),
        submissionNote: note,
    });
    const label = `${version.quoteNumber || "Quote"} v${version.version}${version.grandTotal !== null ? ` (${money(version.grandTotal)})` : ""}`;
    await recordSystemEvent(opportunity, `${label} ${resubmission ? "resubmitted" : "submitted"} for Senior Sales approval${note ? ` — ${note}` : ""}.`, actor);
    await recordActivity({
        actor, ctx, businessUnitId: opportunity.businessUnitId, entityType: "quote_approval", entityId: row.id, entityLabel: `${opportunity.number} ${label}`,
        action: resubmission ? "resubmitted" : "submitted", meta: { quoteVersionId: version.id, round: row.round },
    });
    const approvers = (await usersWithPermissionIn(opportunity.businessUnitId, APPROVE_PERMISSION)).filter((u) => u.id !== actor?.id);
    await notify({
        event: resubmission ? "quote_approval.resubmitted" : "quote_approval.requested",
        title: `${opportunity.number}: quote ${resubmission ? "resubmitted" : "waiting"} for your approval`,
        body: `${customerLabel(opportunity)} — ${label}${actor?.name ? ` from ${actor.name}` : ""}.${note ? ` ${note}` : ""}`,
        userIds: approvers.map((u) => u.id),
        opportunity,
        actor,
    });
    return presentQuoteApproval(await QuoteApproval.findByPk(row.id, { include: INCLUDE }));
};

/** The approver decides: { outcome: approved | rejected, comments } — comments required to reject. */
export const decideApproval = async (id, approvalId, payload = {}, actor, ctx = null) => {
    const opportunity = await loadOpportunity(id);
    if (!(await userHasPermission(actor, APPROVE_PERMISSION))) throw httpError(403, `Missing permission: ${APPROVE_PERMISSION}`);
    const row = await QuoteApproval.findOne({ where: { id: parseId(approvalId, "approval id"), opportunityId: opportunity.id }, include: INCLUDE });
    if (!row) throw httpError(404, "Quote approval not found");
    if (!AWAITING_STATUSES.includes(row.status)) throw httpError(409, `This submission was already ${row.status}${row.approver ? ` by ${row.approver.name}` : ""}`);
    const outcome = String(payload.outcome ?? "");
    if (!["approved", "rejected"].includes(outcome)) throw httpError(400, "outcome must be approved or rejected");
    const comments = multiLine(payload.comments, 4000) || null;
    if (outcome === "rejected" && !comments) throw httpError(400, "Give comments with a rejection — the representative makes the changes from them");
    const isAdmin = Array.isArray(actor?.roles) && actor.roles.includes(SUPER_ROLE_CODE);
    if (!isAdmin && row.submittedById && row.submittedById === actor?.id) throw httpError(403, "A quote must be approved by someone other than the person who submitted it");

    await row.update({ status: outcome, approverId: actor?.id ?? null, decidedAt: new Date(), comments });
    const version = row.quoteVersion;
    const label = `${version?.quoteNumber || "Quote"} v${version?.version ?? "?"}`;
    await recordSystemEvent(opportunity, `${label} ${outcome} by ${actor?.name ?? "the approver"}${comments ? ` — ${comments}` : ""}.`, actor);
    await recordActivity({
        actor, ctx, businessUnitId: opportunity.businessUnitId, entityType: "quote_approval", entityId: row.id, entityLabel: `${opportunity.number} ${label}`,
        action: outcome, meta: { comments, round: row.round, quoteVersionId: row.quoteVersionId },
    });
    await notify({
        event: outcome === "approved" ? "quote_approval.approved" : "quote_approval.rejected",
        title: `${opportunity.number}: ${label} ${outcome}`,
        body: outcome === "approved"
            ? `${customerLabel(opportunity)} — approved by ${actor?.name ?? "the approver"}; you can send it to the customer.${comments ? ` ${comments}` : ""}`
            : `${customerLabel(opportunity)} — rejected by ${actor?.name ?? "the approver"}: ${comments} Make the changes and resubmit it.`,
        userIds: [...new Set([row.submittedById, opportunity.salespersonId].filter(Boolean))],
        opportunity,
        actor,
    });
    return presentQuoteApproval(await QuoteApproval.findByPk(row.id, { include: INCLUDE }));
};

/** Counts for the dashboard. */
export const quoteApprovalStats = async (businessUnitId) => {
    const rows = await QuoteApproval.findAll({ where: { businessUnitId }, attributes: ["status", "submittedAt"], raw: true });
    const by = Object.fromEntries(QUOTE_APPROVAL_STATUSES.map((s) => [s, rows.filter((r) => r.status === s).length]));
    return { awaiting: by.pending + by.resubmitted, byStatus: by, required: await approvalRequiredFor(businessUnitId) };
};
