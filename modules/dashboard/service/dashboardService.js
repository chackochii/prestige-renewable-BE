// The central dashboard: one request for the day's picture of a business unit
// — leads, loans, jobs, projects, installations, finance, suppliers, pricing
// and quote approvals. Each section is included only when the caller may see
// that area (its read permission), so the same endpoint serves every role.
//
// The team view previews (Procurement, Operations) show what that team's
// screens hold, for management to check the work and for the team itself.
import { Op } from "sequelize";
import db from "../../../models/index.js";
import { parseId } from "../../../utils/ids.js";
import { assertUnitAccess } from "../../../utils/unitScope.js";
import { userHasPermission, listPermissionCodesForRoles } from "../../role/service/roleService.js";
import { STAGE_LABELS } from "../../opportunity/service/stageAccess.js";
import { customerLabel } from "../../opportunity/service/opportunityPeople.js";
import { loanStats } from "../../finance/service/loanRequestService.js";
import { paymentStats } from "../../finance/service/customerPaymentService.js";
import { jobStats, presentJob } from "../../delivery/service/jobScheduleService.js";
import { projectStats } from "../../delivery/service/projectService.js";
import { installationStats } from "../../delivery/service/installationService.js";
import { creditOverview } from "../../equipment/service/supplierCreditService.js";
import { equipmentStats } from "../../equipment/service/equipmentService.js";
import { quoteApprovalStats } from "../../opportunity/service/quoteApprovalService.js";
import { recentActivity } from "../../activity/service/activityService.js";
import { TEAM_ROLES } from "../../delivery/model/jobSchedule.js";

const { Opportunity, BusinessUnit, PurchaseOrder, JobSchedule, Project, Installation, Approval, User, sequelize } = db;

const httpError = (status, message) => Object.assign(new Error(message), { status });

const APPROVALS_STAGE = 5;
const PROCUREMENT_STAGE = 6;

const round2 = (n) => Math.round(Number(n) * 100) / 100;

const can = async (user, ...codes) => {
    for (const code of codes) if (await userHasPermission(user, code)) return true;
    return false;
};

const loadUnit = async (businessUnitId, actor) => {
    const unitId = parseId(businessUnitId, "businessUnitId");
    assertUnitAccess(actor, unitId);
    const unit = await BusinessUnit.findByPk(unitId, { attributes: ["id", "code", "name", "timezone"] });
    if (!unit) throw httpError(404, "Business unit not found");
    return unit;
};

// ---- Sections -----------------------------------------------------------------

const leadSection = async (unitId) => {
    const since = new Date(Date.now() - 7 * 86400000);
    const [byStage, byLifecycle, newThisWeek, unassigned, value] = await Promise.all([
        Opportunity.findAll({ where: { businessUnitId: unitId, lifecycle: "Active" }, attributes: ["stage", [sequelize.fn("COUNT", sequelize.col("id")), "n"]], group: ["stage"], raw: true }),
        Opportunity.findAll({ where: { businessUnitId: unitId }, attributes: ["lifecycle", [sequelize.fn("COUNT", sequelize.col("id")), "n"]], group: ["lifecycle"], raw: true }),
        Opportunity.count({ where: { businessUnitId: unitId, createdAt: { [Op.gte]: since } } }),
        Opportunity.count({ where: { businessUnitId: unitId, lifecycle: "Active", stage: 1, salespersonId: null } }),
        Opportunity.findOne({
            where: { businessUnitId: unitId, lifecycle: "Active" },
            attributes: [[sequelize.fn("COALESCE", sequelize.fn("SUM", sequelize.col("estimated_value")), 0), "pipeline"]],
            raw: true,
        }),
    ]);
    const overdue = await Opportunity.count({ where: { businessUnitId: unitId, lifecycle: "Active", slaDueAt: { [Op.lt]: new Date() } } });
    return {
        active: byStage.reduce((n, r) => n + Number(r.n), 0),
        byStage: byStage.map((r) => ({ stage: r.stage, label: STAGE_LABELS[r.stage] ?? null, count: Number(r.n) })).sort((a, b) => a.stage - b.stage),
        byLifecycle: Object.fromEntries(byLifecycle.map((r) => [r.lifecycle, Number(r.n)])),
        newLast7Days: newThisWeek,
        unassignedLeads: unassigned,
        pastSla: overdue,
        pipelineValue: round2(value?.pipeline ?? 0),
    };
};

const billingSection = async (unitId) => {
    const [rows] = await sequelize.query(
        `SELECT COUNT(*)::int AS open, COALESCE(SUM(b.amount_ex + b.gst), 0) AS owed
         FROM billing_requests b JOIN opportunities o ON o.id = b.opportunity_id AND o.deleted_at IS NULL
         WHERE o.business_unit_id = :unitId AND b.status <> 'cancelled' AND b.payment_status = 'unpaid'`,
        { replacements: { unitId } }
    );
    return { unpaidRequests: Number(rows[0]?.open ?? 0), unpaidIncGst: round2(rows[0]?.owed ?? 0) };
};

/**
 * GET /api/dashboard?businessUnitId= → { unit, generatedAt, sections }.
 * A section the caller may not see is left out, not empty.
 */
export const getDashboard = async (query = {}, actor) => {
    const unit = await loadUnit(query.businessUnitId, actor);
    const unitId = unit.id;
    const [seesLeads, seesLoans, seesJobs, seesProjects, seesInstallations, seesFinance, seesCost, seesActivity, seesQuotes] = await Promise.all([
        can(actor, "leads.read"),
        can(actor, "loans.read"),
        can(actor, "construction.read", "procurement.read", "warranty.read"),
        can(actor, "construction.read", "procurement.read", "approvals.read", "leads.read"),
        can(actor, "construction.read", "invoicing.read"),
        can(actor, "invoicing.read"),
        can(actor, "pricing.cost.read"),
        can(actor, "activity.read"),
        can(actor, "quotes.approve", "leads.read", "estimation.read"),
    ]);
    const tasks = {
        leads: seesLeads && leadSection(unitId),
        quoteApprovals: seesQuotes && quoteApprovalStats(unitId),
        loans: seesLoans && loanStats(unitId),
        jobs: seesJobs && jobStats(unitId),
        projects: seesProjects && projectStats(unitId),
        installations: seesInstallations && installationStats(unitId),
        finance: seesFinance && Promise.all([paymentStats(unitId), billingSection(unitId)]).then(([customerPayments, billing]) => ({ customerPayments, billing })),
        suppliers: seesCost && creditOverview().then(({ data, totals }) => ({ ...totals, attention: data.filter((r) => r.overLimit || r.overdue > 0).slice(0, 5) })),
        pricing: equipmentStats(),
        recentActivity: seesActivity && recentActivity(unitId, 10),
    };
    const entries = await Promise.all(Object.entries(tasks).filter(([, task]) => task).map(async ([key, task]) => [key, await task]));
    return { unit: { id: unit.id, code: unit.code, name: unit.name }, generatedAt: new Date().toISOString(), sections: Object.fromEntries(entries) };
};

// ---- Team view previews ------------------------------------------------------

/** Who may preview a team's view: management (admin.read) or the team itself. */
const PREVIEW_ACCESS = {
    procurement: ["admin.read", "procurement.update", "procurement.approve"],
    operations: ["admin.read", "construction.update", "approvals.update"],
};

/** The roles whose screens a preview shows, and what they hold. */
const PREVIEW_ROLES = { procurement: ["PROC"], operations: ["BOM", "OPC"] };

const jobBrief = (o) => ({ id: o.id, number: o.number, customer: customerLabel(o), suburb: o.siteSuburb ?? null, enteredAt: o.slaStartedAt ?? null, slaDueAt: o.slaDueAt ?? null, overdue: Boolean(o.slaDueAt && new Date(o.slaDueAt) < new Date()) });
const OPP_BRIEF = ["id", "number", "customerLegalName", "customerTradingName", "siteSuburb", "slaStartedAt", "slaDueAt", "stage"];

const upcomingJobs = async (unitId, teams, days = 7) => {
    const now = new Date();
    const rows = await JobSchedule.findAll({
        where: { businessUnitId: unitId, team: { [Op.in]: teams }, status: { [Op.in]: ["scheduled", "in_progress"] }, scheduledStart: { [Op.lte]: new Date(now.getTime() + days * 86400000) } },
        include: [
            { model: Opportunity, as: "opportunity", attributes: ["id", "number", "customerLegalName", "customerTradingName", "siteLine1", "siteSuburb", "siteState", "sitePostcode"] },
            { model: User, as: "assignee", attributes: ["id", "name"] },
        ],
        order: [["scheduledStart", "ASC"]],
        limit: 25,
    });
    return rows.map(presentJob);
};

const procurementView = async (unit, actor) => {
    const unitId = unit.id;
    const seesCost = await can(actor, "pricing.cost.read");
    const [jobs, poRows, deliveries, schedule, equipment] = await Promise.all([
        Opportunity.findAll({ where: { businessUnitId: unitId, lifecycle: "Active", stage: PROCUREMENT_STAGE }, attributes: OPP_BRIEF, order: [["slaDueAt", "ASC"]], limit: 25 }),
        sequelize.query(
            `SELECT p.status, COUNT(*)::int AS n, COALESCE(SUM(p.amount), 0) AS total
             FROM purchase_orders p JOIN opportunities o ON o.id = p.opportunity_id AND o.deleted_at IS NULL
             WHERE o.business_unit_id = :unitId GROUP BY p.status`,
            { replacements: { unitId }, type: sequelize.QueryTypes.SELECT }
        ),
        PurchaseOrder.findAll({
            where: { status: { [Op.in]: ["sent", "confirmed", "scheduled"] } },
            include: [{ model: Opportunity, as: "opportunity", attributes: ["id", "number", "businessUnitId", "customerLegalName", "customerTradingName"], where: { businessUnitId: unitId }, required: true }],
            order: [["eta", "ASC"]],
            limit: 25,
        }),
        upcomingJobs(unitId, ["procurement"], 14),
        equipmentStats(),
    ]);
    const credit = seesCost ? await creditOverview() : null;
    return {
        inProcurement: { count: jobs.length, jobs: jobs.map(jobBrief) },
        purchaseOrders: {
            byStatus: Object.fromEntries(poRows.map((r) => [r.status, { count: Number(r.n), ...(seesCost ? { total: round2(r.total) } : {}) }])),
            awaitingDelivery: deliveries.map((po) => ({
                id: po.id, ref: po.ref, supplier: po.supplier, status: po.status, eta: po.eta ?? null, scheduledFor: po.scheduledFor ?? null,
                job: { id: po.opportunity.id, number: po.opportunity.number, customer: customerLabel(po.opportunity) }, ...(seesCost ? { amount: Number(po.amount) } : {}),
            })),
        },
        deliveriesScheduled: schedule,
        equipment: { active: equipment.equipmentActive, unpriced: equipment.unpriced, suppliersActive: equipment.suppliersActive },
        ...(credit ? { supplierCredit: { ...credit.totals, attention: credit.data.filter((r) => r.overLimit || r.overdue > 0).slice(0, 10) } } : {}),
    };
};

const operationsView = async (unit) => {
    const unitId = unit.id;
    const [approvalJobs, pendingApprovalRows, projects, activeProjects, schedule, notInvoiced, jobs] = await Promise.all([
        Opportunity.findAll({ where: { businessUnitId: unitId, lifecycle: "Active", stage: APPROVALS_STAGE }, attributes: OPP_BRIEF, order: [["slaDueAt", "ASC"]], limit: 25 }),
        Approval.findAll({
            where: { required: true, status: { [Op.in]: ["not_started", "submitted", "rejected"] } },
            include: [{ model: Opportunity, as: "opportunity", attributes: ["id"], where: { businessUnitId: unitId, lifecycle: "Active" }, required: true }],
            attributes: ["id", "status"],
        }),
        projectStats(unitId),
        Project.findAll({
            where: { businessUnitId: unitId, status: { [Op.notIn]: ["completed", "cancelled"] } },
            include: [{ model: Opportunity, as: "opportunity", attributes: ["id", "number", "customerLegalName", "customerTradingName", "siteSuburb"] }],
            order: [["expectedInstallDate", "ASC"], ["id", "ASC"]],
            limit: 25,
        }),
        upcomingJobs(unitId, ["crew", "operations", "om"], 7),
        Installation.count({ where: { businessUnitId: unitId, invoiceStatus: "not_invoiced" } }),
        jobStats(unitId),
    ]);
    return {
        inApprovals: {
            count: approvalJobs.length,
            jobs: approvalJobs.map(jobBrief),
            outstanding: { notStarted: pendingApprovalRows.filter((a) => a.status === "not_started").length, submitted: pendingApprovalRows.filter((a) => a.status === "submitted").length, rejected: pendingApprovalRows.filter((a) => a.status === "rejected").length },
        },
        projects: {
            ...projects,
            list: activeProjects.map((p) => ({
                id: p.id, code: p.code, status: p.status, paymentType: p.paymentType, installationStatus: p.installationStatus, installationProgressPct: p.installationProgressPct,
                procurementStatus: p.procurementStatus, expectedInstallDate: p.expectedInstallDate ?? null,
                job: p.opportunity ? { id: p.opportunity.id, number: p.opportunity.number, customer: customerLabel(p.opportunity), suburb: p.opportunity.siteSuburb ?? null } : null,
            })),
        },
        schedule: { ...jobs, next7Days: schedule },
        installationsAwaitingInvoice: notInvoiced,
    };
};

/**
 * GET /api/dashboard/views/:team?businessUnitId= — team: procurement | operations.
 * → { team, unit, roles: [{ code, name, permissions }], data }.
 */
export const getTeamView = async (team, query = {}, actor) => {
    if (!PREVIEW_ACCESS[team]) throw httpError(404, `No preview for "${team}" — use procurement or operations`);
    if (!(await can(actor, ...PREVIEW_ACCESS[team]))) throw httpError(403, `Previewing the ${team} view needs one of: ${PREVIEW_ACCESS[team].join(", ")}`);
    const unit = await loadUnit(query.businessUnitId, actor);
    const roles = await db.Role.findAll({ where: { code: PREVIEW_ROLES[team] }, attributes: ["code", "name"] });
    const data = team === "procurement" ? await procurementView(unit, actor) : await operationsView(unit);
    return {
        team,
        unit: { id: unit.id, code: unit.code, name: unit.name },
        roles: await Promise.all(roles.map(async (r) => ({ code: r.code, name: r.name, permissions: await listPermissionCodesForRoles([r.code]) }))),
        scheduleTeams: team === "procurement" ? { procurement: TEAM_ROLES.procurement } : { crew: TEAM_ROLES.crew, operations: TEAM_ROLES.operations, om: TEAM_ROLES.om },
        generatedAt: new Date().toISOString(),
        data,
    };
};
