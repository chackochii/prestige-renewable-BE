// Projects: the operations view of a signed job. One is created when the
// customer accepts the proposal (ensureProjectFor, from proposalService) or by
// hand for a job signed outside the system. Operations updates the payment
// type, the loan it rides on, the installation and procurement progress and
// the people; the approval status is read live off the job's approvals and
// the documents off the job's documents, so neither can drift.
import { Op } from "sequelize";
import db from "../../../models/index.js";
import logger from "../../../utils/logger.js";
import { parseId } from "../../../utils/ids.js";
import { pagingOf } from "../../../utils/pagination.js";
import { assertUnitAccess, canAccessUnit, unitScopeOf } from "../../../utils/unitScope.js";
import { recordActivity, diff } from "../../activity/service/activityService.js";
import { notify } from "../../notification/service/notificationService.js";
import { recordSystemEvent } from "../../opportunity/service/leadWorkflowService.js";
import { customerLabel } from "../../opportunity/service/opportunityPeople.js";
import { presentDocument } from "../../opportunity/service/leadAttachmentService.js";
import { STAGE_LABELS } from "../../opportunity/service/stageAccess.js";
import { presentJob } from "./jobScheduleService.js";
import { PROJECT_STATUSES, PAYMENT_TYPES, INSTALLATION_STATUSES, PROCUREMENT_STATUSES } from "../model/project.js";
import { httpError, isBlank, optionalLongText, oneOf, dateOnly, wholeNumber, nextCode, round2, userBrief } from "../../equipment/service/shared.js";

const { Project, Opportunity, BusinessUnit, User, Approval, Document, Proposal, QuoteVersion, LoanRequest, JobSchedule, Installation, CustomerPayment, PurchaseOrder, ProcurementJob, sequelize } = db;

const OPP_ATTRS = [
    "id", "number", "stage", "lifecycle", "businessUnitId", "customerLegalName", "customerTradingName", "customerEmail", "customerPhone",
    "siteLine1", "siteSuburb", "siteState", "sitePostcode", "salespersonId", "operationalCoordinatorId", "acceptedValue", "estimatedValue",
    "installWindowStart", "installWindowEnd",
];
const INCLUDE = [
    { model: Opportunity, as: "opportunity", attributes: OPP_ATTRS },
    { model: BusinessUnit, as: "businessUnit", attributes: ["id", "code", "name"] },
    { model: User, as: "assignedRep", attributes: ["id", "name"] },
    { model: User, as: "operationsOwner", attributes: ["id", "name"] },
    { model: LoanRequest, as: "loanRequest", attributes: ["id", "number", "status", "loanAmount", "financier"] },
];

const siteOf = (o) => (o ? [o.siteLine1, o.siteSuburb, o.siteState, o.sitePostcode].filter(Boolean).join(", ") : "");
const receivedOf = (p) => (p.receipts ?? []).reduce((s, r) => s + (Number(r.amount) || 0), 0);

/** pending | approved | rejected | not_required, with the rows, from the job's approvals. */
export const approvalStateOf = (approvals) => {
    const required = approvals.filter((a) => a.required);
    if (!required.length) return { status: "not_required", approved: 0, required: 0, rejected: 0, items: [] };
    const rejected = required.filter((a) => a.status === "rejected").length;
    const done = required.filter((a) => ["approved", "not_applicable"].includes(a.status)).length;
    return {
        status: rejected ? "rejected" : done === required.length ? "approved" : "pending",
        approved: done,
        required: required.length,
        rejected,
        items: required.map((a) => ({ type: a.type, label: a.label, status: a.status, authority: a.authority ?? null, reference: a.reference ?? null, outcomeAt: a.outcomeAt ?? null })),
    };
};

export const presentProject = (row, extra = {}) => ({
    id: row.id,
    code: row.code,
    status: row.status,
    paymentType: row.paymentType,
    loanRequest: row.loanRequest
        ? { id: row.loanRequest.id, number: row.loanRequest.number, status: row.loanRequest.status, loanAmount: Number(row.loanRequest.loanAmount), financier: row.loanRequest.financier ?? null }
        : null,
    installationStatus: row.installationStatus,
    installationProgressPct: row.installationProgressPct,
    procurementStatus: row.procurementStatus,
    job: row.opportunity
        ? {
              id: row.opportunity.id,
              number: row.opportunity.number,
              stage: row.opportunity.stage,
              stageLabel: STAGE_LABELS[row.opportunity.stage] ?? null,
              lifecycle: row.opportunity.lifecycle,
              customer: customerLabel(row.opportunity),
              email: row.opportunity.customerEmail ?? null,
              phone: row.opportunity.customerPhone ?? null,
              site: siteOf(row.opportunity),
              value: Number(row.opportunity.acceptedValue) || Number(row.opportunity.estimatedValue) || 0,
              installWindowStart: row.opportunity.installWindowStart ?? null,
              installWindowEnd: row.opportunity.installWindowEnd ?? null,
          }
        : { id: row.opportunityId },
    businessUnit: row.businessUnit ? { id: row.businessUnit.id, code: row.businessUnit.code, name: row.businessUnit.name } : { id: row.businessUnitId },
    assignedRep: userBrief(row.assignedRep),
    operationsOwner: userBrief(row.operationsOwner),
    signedAt: row.signedAt ?? null,
    expectedInstallDate: row.expectedInstallDate ?? null,
    notes: row.notes ?? null,
    ...extra,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
});

const loadProject = async (id, actor) => {
    const row = await Project.findByPk(parseId(id, "project id"), { include: INCLUDE });
    if (!row || !canAccessUnit(actor, row.businessUnitId)) throw httpError(404, "Project not found");
    return row;
};

/** The whole project: approvals, documents, the signed quote, jobs, installations, payments, purchase orders. */
const full = async (row) => {
    const opportunityId = row.opportunityId;
    const [approvals, documents, accepted, jobs, installations, payments, purchaseOrders, procurement] = await Promise.all([
        Approval.findAll({ where: { opportunityId }, order: [["id", "ASC"]] }),
        Document.findAll({ where: { opportunityId }, include: [{ model: User, as: "uploader", attributes: ["id", "name"] }], order: [["createdAt", "DESC"]], limit: 200 }),
        Proposal.findOne({
            where: { opportunityId, status: "accepted" },
            include: [{ model: QuoteVersion, as: "quoteVersion", attributes: ["id", "version", "quoteNumber", "grandTotal", "createdAt"] }],
            order: [["acceptedAt", "DESC"]],
        }),
        JobSchedule.findAll({ where: { opportunityId }, include: [{ model: User, as: "assignee", attributes: ["id", "name"] }], order: [["scheduledStart", "ASC"]] }),
        Installation.findAll({ where: { opportunityId }, include: [{ model: User, as: "installer", attributes: ["id", "name"] }], order: [["installationDate", "DESC"]] }),
        CustomerPayment.findAll({ where: { opportunityId }, order: [["dueAt", "ASC"]] }),
        PurchaseOrder.findAll({ where: { opportunityId }, attributes: ["id", "ref", "supplier", "amount", "status", "eta", "scheduledFor", "deliveredAt"], order: [["id", "ASC"]] }),
        ProcurementJob.findOne({ where: { opportunityId }, attributes: ["id", "enteredAt"] }),
    ]);
    const live = payments.filter((p) => p.status !== "cancelled");
    return presentProject(row, {
        approvals: approvalStateOf(approvals),
        documents: documents.map(presentDocument),
        signedQuote: accepted?.quoteVersion
            ? {
                  proposalNumber: accepted.number,
                  acceptedAt: accepted.acceptedAt,
                  quoteVersionId: accepted.quoteVersion.id,
                  version: accepted.quoteVersion.version,
                  quoteNumber: accepted.quoteVersion.quoteNumber,
                  grandTotal: accepted.quoteVersion.grandTotal === null ? null : Number(accepted.quoteVersion.grandTotal),
              }
            : null,
        jobs: jobs.map((j) => {
            const { job, businessUnit, ...rest } = presentJob(j);
            return rest;
        }),
        installations: installations.map((i) => ({
            id: i.id, installationDate: i.installationDate, jobDescription: i.jobDescription ?? null, paymentMethod: i.paymentMethod,
            invoiceStatus: i.invoiceStatus, invoiceNumber: i.invoiceNumber ?? null, installer: userBrief(i.installer),
        })),
        payments: {
            owedInc: round2(live.reduce((s, p) => s + Number(p.amountInc), 0)),
            received: round2(live.reduce((s, p) => s + receivedOf(p), 0)),
            items: payments.map((p) => ({ id: p.id, description: p.description, amountInc: Number(p.amountInc), received: round2(receivedOf(p)), dueAt: p.dueAt ?? null, status: p.status })),
        },
        purchaseOrders: purchaseOrders.map((po) => ({
            id: po.id, ref: po.ref, supplier: po.supplier, amount: Number(po.amount), status: po.status, eta: po.eta ?? null, scheduledFor: po.scheduledFor ?? null, deliveredAt: po.deliveredAt ?? null,
        })),
        procurement: procurement ? { enteredAt: procurement.enteredAt } : null,
    });
};

// ---- Reads ----------------------------------------------------------------

/** ?businessUnitId=&status=&active=1&paymentType=&installationStatus=&procurementStatus=&repId=&search=&page=&pageSize= */
export const listProjects = async (query = {}, actor) => {
    const where = {};
    const scope = unitScopeOf(actor);
    if (!isBlank(query.businessUnitId)) {
        const unitId = parseId(query.businessUnitId, "businessUnitId");
        assertUnitAccess(actor, unitId);
        where.businessUnitId = unitId;
    } else if (scope) where.businessUnitId = { [Op.in]: scope };
    if (query.paymentType) where.paymentType = oneOf(query.paymentType, PAYMENT_TYPES, "paymentType");
    if (query.installationStatus) where.installationStatus = oneOf(query.installationStatus, INSTALLATION_STATUSES, "installationStatus");
    if (query.procurementStatus) where.procurementStatus = oneOf(query.procurementStatus, PROCUREMENT_STATUSES, "procurementStatus");
    if (!isBlank(query.repId)) where.assignedRepId = parseId(query.repId, "repId");
    // Counted before the status and search filters, so the chips show every status.
    const countWhere = { ...where };
    if (query.status) where.status = oneOf(query.status, PROJECT_STATUSES, "status");
    if (query.active === "1" || query.active === "true") where.status = { [Op.notIn]: ["completed", "cancelled"] };
    if (query.search) {
        const term = `%${String(query.search).trim().slice(0, 100)}%`;
        where[Op.or] = [
            { code: { [Op.iLike]: term } },
            { "$opportunity.number$": { [Op.iLike]: term } },
            { "$opportunity.customer_legal_name$": { [Op.iLike]: term } },
            { "$opportunity.site_suburb$": { [Op.iLike]: term } },
        ];
    }
    const paging = pagingOf(query, { defaultSize: 12, maxSize: 100 });
    const { rows, count } = await Project.findAndCountAll({
        where, include: INCLUDE, order: [["createdAt", "DESC"], ["id", "DESC"]], limit: paging.limit, offset: paging.offset, subQuery: false, distinct: true,
    });
    const approvals = rows.length ? await Approval.findAll({ where: { opportunityId: rows.map((r) => r.opportunityId) } }) : [];
    const byJob = new Map();
    for (const a of approvals) {
        if (!byJob.has(a.opportunityId)) byJob.set(a.opportunityId, []);
        byJob.get(a.opportunityId).push(a);
    }
    const counts = await Project.findAll({
        attributes: ["status", [sequelize.fn("COUNT", sequelize.col("id")), "n"]],
        where: countWhere,
        group: ["status"],
        raw: true,
    });
    const byStatus = Object.fromEntries(PROJECT_STATUSES.map((s) => [s, 0]));
    for (const c of counts) byStatus[c.status] = Number(c.n);
    return {
        data: rows.map((row) => {
            const { items, ...approval } = approvalStateOf(byJob.get(row.opportunityId) ?? []);
            return presentProject(row, { approvals: approval });
        }),
        total: count,
        page: paging.page,
        pageSize: paging.pageSize,
        counts: byStatus,
    };
};

export const getProject = async (id, actor) => full(await loadProject(id, actor));

/** The project on a job, or null when it has none (or the caller cannot see it). */
export const getProjectForOpportunity = async (opportunityId, actor) => {
    const row = await Project.findOne({ where: { opportunityId: parseId(opportunityId, "opportunity id") }, include: INCLUDE });
    if (!row || !canAccessUnit(actor, row.businessUnitId)) return null;
    return full(row);
};

// ---- Writes ---------------------------------------------------------------

const nextProjectCode = async (unit, transaction) => {
    const year = String(new Date().getFullYear()).slice(-2);
    const prefix = `${unit.code}-PRJ-${year}-`;
    const existing = await Project.findAll({ where: { code: { [Op.like]: `${prefix}%` } }, attributes: ["code"], transaction, raw: true });
    return nextCode(prefix, existing.map((r) => r.code), 4);
};

// Project codes are numbered per unit; the same advisory lock the lead numbers
// use (a different first key) keeps two creates from taking the same number.
const PROJECT_NUMBERING_LOCK_KEY = 2;
const lockProjectNumbering = (unit, transaction) =>
    sequelize.query("SELECT pg_advisory_xact_lock(:key, :unitId)", { replacements: { key: PROJECT_NUMBERING_LOCK_KEY, unitId: unit.id }, transaction });

const resolveUser = async (value, label) => {
    if (isBlank(value)) return null;
    const user = await User.findByPk(parseId(value, label), { attributes: ["id", "status"] });
    if (!user || user.status !== "active") throw httpError(400, `${label} must be an active user`);
    return user.id;
};

const resolveLoan = async (value, opportunityId) => {
    if (isBlank(value)) return null;
    const loan = await LoanRequest.findByPk(parseId(value, "loanRequestId"));
    if (!loan || loan.opportunityId !== opportunityId) throw httpError(400, "That loan request is not this job's");
    return loan.id;
};

/**
 * Creates the project for an opportunity if it has none (idempotent). Called
 * when the customer accepts the proposal; failures are logged, never thrown,
 * so an acceptance is never refused over the project record.
 */
export const ensureProjectFor = async (opportunity, actor = null, { paymentType = null, signedAt = null } = {}) => {
    try {
        const existing = await Project.findOne({ where: { opportunityId: opportunity.id } });
        if (existing) return existing;
        const unit = await BusinessUnit.findByPk(opportunity.businessUnitId);
        if (!unit) return null;
        const loan = await LoanRequest.findOne({
            where: { opportunityId: opportunity.id, status: { [Op.in]: ["submitted", "under_review", "more_info", "approved"] } },
            order: [["createdAt", "DESC"]],
        });
        const row = await sequelize.transaction(async (transaction) => {
            await lockProjectNumbering(unit, transaction);
            const again = await Project.findOne({ where: { opportunityId: opportunity.id }, transaction });
            if (again) return again;
            return Project.create(
                {
                    opportunityId: opportunity.id,
                    businessUnitId: opportunity.businessUnitId,
                    code: await nextProjectCode(unit, transaction),
                    paymentType: paymentType ?? (loan || opportunity.financeAssistance === "yes" ? "loan" : "cash"),
                    loanRequestId: loan?.id ?? null,
                    status: "signed",
                    assignedRepId: opportunity.salespersonId ?? null,
                    operationsOwnerId: opportunity.operationalCoordinatorId ?? opportunity.deliveryOwnerId ?? null,
                    signedAt: signedAt ?? new Date(),
                    expectedInstallDate: opportunity.installWindowStart ?? null,
                    createdById: actor?.id ?? null,
                },
                { transaction }
            );
        });
        await recordSystemEvent(opportunity, `Project ${row.code} opened (${row.paymentType}).`, actor);
        await recordActivity({
            actor, source: actor ? null : "system", businessUnitId: row.businessUnitId, entityType: "project", entityId: row.id, entityLabel: row.code,
            action: "created", meta: { opportunity: opportunity.number, paymentType: row.paymentType, auto: true },
        });
        return row;
    } catch (err) {
        logger.error(`Project could not be created for ${opportunity.number}: ${err.message}`);
        return null;
    }
};

/** By hand: { opportunityId, paymentType?, loanRequestId?, signedAt?, expectedInstallDate?, operationsOwnerId?, notes? } */
export const createProject = async (payload = {}, actor, ctx) => {
    const opportunity = await Opportunity.findByPk(parseId(payload.opportunityId, "opportunityId"));
    if (!opportunity || !canAccessUnit(actor, opportunity.businessUnitId)) throw httpError(404, "Opportunity not found");
    if (await Project.findOne({ where: { opportunityId: opportunity.id } })) throw httpError(409, "This job already has a project");
    const unit = await BusinessUnit.findByPk(opportunity.businessUnitId);
    const paymentType = isBlank(payload.paymentType) ? "cash" : oneOf(payload.paymentType, PAYMENT_TYPES, "paymentType");
    const loanRequestId = await resolveLoan(payload.loanRequestId, opportunity.id);
    const operationsOwnerId = (await resolveUser(payload.operationsOwnerId, "operationsOwnerId")) ?? opportunity.operationalCoordinatorId ?? null;
    const signedAt = isBlank(payload.signedAt) ? new Date() : new Date(payload.signedAt);
    if (Number.isNaN(signedAt.getTime())) throw httpError(400, "signedAt must be a date");
    const row = await sequelize.transaction(async (transaction) => {
        await lockProjectNumbering(unit, transaction);
        return Project.create(
            {
                opportunityId: opportunity.id,
                businessUnitId: opportunity.businessUnitId,
                code: await nextProjectCode(unit, transaction),
                paymentType: loanRequestId ? "loan" : paymentType,
                loanRequestId,
                status: "signed",
                assignedRepId: opportunity.salespersonId ?? null,
                operationsOwnerId,
                signedAt,
                expectedInstallDate: dateOnly(payload.expectedInstallDate, "expectedInstallDate") ?? opportunity.installWindowStart ?? null,
                notes: optionalLongText(payload.notes, "notes", 5000),
                createdById: actor?.id ?? null,
            },
            { transaction }
        );
    });
    await recordSystemEvent(opportunity, `Project ${row.code} opened (${row.paymentType})${actor?.name ? ` by ${actor.name}` : ""}.`, actor);
    await recordActivity({ actor, ctx, businessUnitId: row.businessUnitId, entityType: "project", entityId: row.id, entityLabel: row.code, action: "created", meta: { opportunity: opportunity.number, paymentType: row.paymentType } });
    return getProject(row.id, actor);
};

const EDITABLE = ["status", "paymentType", "loanRequestId", "installationStatus", "installationProgressPct", "procurementStatus", "assignedRepId", "operationsOwnerId", "signedAt", "expectedInstallDate", "notes"];

/** Operations updates any of EDITABLE. Installation at 100 % reads as completed, and the other way round. */
export const updateProject = async (id, payload = {}, actor, ctx) => {
    const row = await loadProject(id, actor);
    const before = { ...row.get({ plain: true }) }; // a copy: without includes Sequelize hands back the live dataValues
    const updates = {};
    if (payload.status !== undefined) updates.status = oneOf(payload.status, PROJECT_STATUSES, "status");
    if (payload.paymentType !== undefined) updates.paymentType = oneOf(payload.paymentType, PAYMENT_TYPES, "paymentType");
    if (payload.loanRequestId !== undefined) updates.loanRequestId = await resolveLoan(payload.loanRequestId, row.opportunityId);
    if (payload.installationStatus !== undefined) updates.installationStatus = oneOf(payload.installationStatus, INSTALLATION_STATUSES, "installationStatus");
    if (payload.installationProgressPct !== undefined) {
        updates.installationProgressPct = wholeNumber(payload.installationProgressPct, "installationProgressPct", { min: 0 });
        if (updates.installationProgressPct > 100) throw httpError(400, "installationProgressPct must be 0–100");
    }
    if (payload.procurementStatus !== undefined) updates.procurementStatus = oneOf(payload.procurementStatus, PROCUREMENT_STATUSES, "procurementStatus");
    if (payload.assignedRepId !== undefined) updates.assignedRepId = await resolveUser(payload.assignedRepId, "assignedRepId");
    if (payload.operationsOwnerId !== undefined) updates.operationsOwnerId = await resolveUser(payload.operationsOwnerId, "operationsOwnerId");
    if (payload.signedAt !== undefined) {
        updates.signedAt = isBlank(payload.signedAt) ? null : new Date(payload.signedAt);
        if (updates.signedAt && Number.isNaN(updates.signedAt.getTime())) throw httpError(400, "signedAt must be a date");
    }
    if (payload.expectedInstallDate !== undefined) updates.expectedInstallDate = dateOnly(payload.expectedInstallDate, "expectedInstallDate");
    if (payload.notes !== undefined) updates.notes = optionalLongText(payload.notes, "notes", 5000);
    if (!Object.keys(updates).length) throw httpError(400, `No fields provided. Editable: ${EDITABLE.join(", ")}`);
    // Progress and status agree with each other.
    if (updates.installationStatus === "completed" && updates.installationProgressPct === undefined) updates.installationProgressPct = 100;
    if (updates.installationProgressPct === 100 && updates.installationStatus === undefined) updates.installationStatus = "completed";
    if (updates.installationProgressPct > 0 && updates.installationProgressPct < 100 && updates.installationStatus === undefined && ["not_started", "scheduled"].includes(row.installationStatus))
        updates.installationStatus = "in_progress";
    if (updates.loanRequestId && updates.paymentType === undefined) updates.paymentType = "loan";
    await row.update(updates);
    const fresh = await loadProject(row.id, actor);
    const changes = diff(before, fresh.get({ plain: true }), Object.keys(updates));
    if (changes) {
        await recordActivity({ actor, ctx, businessUnitId: row.businessUnitId, entityType: "project", entityId: row.id, entityLabel: row.code, action: changes.status ? `status_${fresh.status}` : "updated", changes });
        if (fresh.opportunity) {
            const said = Object.entries(changes).map(([k, v]) => `${k}: ${v.from ?? "—"} → ${v.to ?? "—"}`).join("; ");
            await recordSystemEvent(fresh.opportunity, `Project ${row.code} updated — ${said}.`.slice(0, 4900), actor);
            if (changes.status || changes.installationStatus)
                await notify({
                    event: "project.updated",
                    title: `${row.code}: ${changes.status ? fresh.status.replace("_", " ") : `installation ${fresh.installationStatus.replace("_", " ")}`}`,
                    body: `${fresh.opportunity.number} · ${customerLabel(fresh.opportunity)}${actor?.name ? ` — ${actor.name}` : ""}.`,
                    userIds: [fresh.assignedRepId, fresh.operationsOwnerId].filter(Boolean),
                    opportunity: fresh.opportunity,
                    actor,
                });
        }
    }
    return full(fresh);
};

export const deleteProject = async (id, actor, ctx) => {
    const row = await loadProject(id, actor);
    const installed = await Installation.count({ where: { projectId: row.id } });
    if (installed) throw httpError(409, "Installations are recorded against this project — cancel it instead of deleting it");
    await row.destroy();
    await recordActivity({ actor, ctx, businessUnitId: row.businessUnitId, entityType: "project", entityId: row.id, entityLabel: row.code, action: "deleted" });
};

/** Dashboard counts for one unit. */
export const projectStats = async (businessUnitId) => {
    const rows = await Project.findAll({ where: { businessUnitId }, attributes: ["status", "paymentType", "installationStatus", "procurementStatus"], raw: true });
    const count = (key, values) => Object.fromEntries(values.map((v) => [v, rows.filter((r) => r[key] === v).length]));
    return {
        total: rows.length,
        active: rows.filter((r) => !["completed", "cancelled"].includes(r.status)).length,
        byStatus: count("status", PROJECT_STATUSES),
        byPaymentType: count("paymentType", PAYMENT_TYPES),
        byInstallationStatus: count("installationStatus", INSTALLATION_STATUSES),
        byProcurementStatus: count("procurementStatus", PROCUREMENT_STATUSES),
    };
};
