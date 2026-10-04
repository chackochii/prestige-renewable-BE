// Procurement & delivery (stage 6), as the Sydpro process chart has it:
//
//   BOQ / BOS availability & verification
//     → proposal BOQ vs actual site BOQ match?   yes: start getting quotes
//                                                no:  revise the BOQ to the site
//                                                     figures — a new round
//     → price variation?                         no:  start sending POs
//         below 5%  → sales manager approves
//         5% or more → owner + sales manager approve
//     → all approvals received?                  no:  high-priority notifications
//     → purchase orders sent, deliveries scheduled and received
//     → Green Deal job creation
//     → Construction & commissioning
//
// One procurement_jobs row per opportunity, created when the job enters the
// stage (enterProcurement, from moveToNextStage) with its BOQ seeded from the
// accepted quote. The Operations Coordinator works the stage through five
// checklists (prestige-fe constants/procurementChecklists.js — CL-11 BOQ vs
// site, CL-12 supplier quote, CL-13 PO release, CL-14 material receipt,
// CL-10 job creation); their answers live here as JSON, and what they settle
// is applied to the record: the orders go out, the deliveries land, the Green
// Deal job is created. The rules below mirror prestige-fe helpers/procurement.js
// so the screen and the API agree on where a job is.

import { Op } from "sequelize";
import db from "../../../models/index.js";
import { parseId } from "../../../utils/ids.js";
import { multiLine, oneLine } from "../../../utils/text.js";
import { notify } from "../../notification/service/notificationService.js";
import { SUPER_ROLE_CODE, userHasPermission } from "../../role/service/roleService.js";
import { OPERATIONS_COORDINATOR_ROLE, recordSystemEvent } from "./leadWorkflowService.js";
import { customerLabel } from "./opportunityPeople.js";
import { searchCondition } from "./opportunityService.js";
import { readableStages } from "./stageAccess.js";
import { VARIATION_ESCALATION_PERCENT, variationApproverRoles } from "./approvalPolicy.js";
import { acceptedProposalsFor, siteOf } from "./approvalsService.js";
import { PURCHASE_ORDER_STATUSES } from "../model/purchaseOrder.js";
import { newestFirst, pageOf, pagingOf } from "../../../utils/pagination.js";

const { Opportunity, ProcurementJob, PurchaseOrder, User, OpportunityHistory, Notification } = db;

const httpError = (status, message) => Object.assign(new Error(message), { status });

export const PROCUREMENT_STAGE = 6;
export const CHECKLIST_SECTIONS = ["boq", "quote", "po", "receipt", "jobCreation"];
const SECTION_CODES = { boq: "CL-11 BOQ vs site requirement", quote: "CL-12 supplier quote", po: "CL-13 purchase order release", receipt: "CL-14 material receipt", jobCreation: "CL-10 job creation" };
const AVAILABILITY = ["available", "lead_time", "backorder"];
const LINE_KINDS = ["material", "service"];
/** Who approves a price variation, by role code (approvalPolicy.variationApproverRoles). */
export const APPROVER_ROLES = { SMM: "Sales manager", BO: "Business owner" };
const PROCUREMENT_ROLE = "PROC";
const SITE_OPERATIONS_ROLE = "SITEOM";
const BUSINESS_OPERATIONS_ROLE = "BOM";
/** Checklist items the Procurement Manager signs (item.owner on the frontend's definition). */
const MANAGER_KEYS = { boq: ["changesApproved", "changesApprovedDetails"], po: ["releaseApproved"] };
const PER_JOB_LIMIT = 100;
const MAX_LINES = 200;
/** A quote line that is work rather than goods — the BOS half of the BOQ. */
const SERVICE_PATTERN = /install|labou?r|commission|electrical|crane|scaffold|service|freight|delivery|travel|permit|inspection|design|engineering/i;

// ---- Small helpers -------------------------------------------------------------

const num = (value) => (value === null || value === undefined || value === "" ? null : Number(value));
const qty = (value) => Number(value) || 0;
const blank = (value) => value === undefined || value === null || String(value).trim() === "";
const hasFiles = (value) => Array.isArray(value) && value.length > 0;
const isNumber = (value) => !blank(value) && Number.isFinite(Number(value));
const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isSuper = (actor) => Array.isArray(actor?.roles) && actor.roles.includes(SUPER_ROLE_CODE);
const money = (value) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(Number(value) || 0);
const signedPct = (pct) => `${pct > 0 ? "+" : ""}${Number(pct).toFixed(1)}%`;

const nonNegative = (value, field) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw httpError(400, `${field} must be a number of 0 or more`);
    return n;
};

const parseDate = (value, field) => {
    if (value === null || value === undefined || value === "") return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw httpError(400, `${field} must be a date`);
    return date;
};

const dateOnly = (value, field) => {
    const date = parseDate(value, field);
    return date ? date.toISOString().slice(0, 10) : null;
};

const loadOpportunity = async (id) => {
    const opportunity = await Opportunity.findByPk(parseId(id, "opportunity id"));
    if (!opportunity) throw httpError(404, "Opportunity not found");
    return opportunity;
};

// ---- The rules, mirrored from prestige-fe helpers/procurement.js -------------------

const linesOf = (row) => (Array.isArray(row?.boq) ? row.boq : []);
const revisionsOf = (row) => (Array.isArray(row?.revisions) ? row.revisions : []);
const quotesOf = (row) => (Array.isArray(row?.quotes) ? row.quotes : []);
const approvalsOf = (row) => (Array.isArray(row?.approvals) ? row.approvals : []);
const checklistOf = (row) => (isPlainObject(row?.checklist) ? row.checklist : {});
const answersOf = (row, section) => (isPlainObject(checklistOf(row)[section]) ? checklistOf(row)[section] : {});
const isQuoted = (line) => line.quotedUnitCost !== null && line.quotedUnitCost !== undefined && line.quotedUnitCost !== "";

/** The accepted proposal's lines — round 1 — which the price variation is always measured from. */
const originalLines = (row) => revisionsOf(row)[0]?.lines ?? linesOf(row);
const mismatchedLines = (row) => linesOf(row).filter((line) => qty(line.proposalQty) !== qty(line.siteQty));
export const quotesReceived = (row) => linesOf(row).length > 0 && linesOf(row).every(isQuoted);
const proposalTotal = (row) => originalLines(row).reduce((sum, line) => sum + qty(line.proposalQty) * qty(line.proposalUnitCost), 0);
const quotedTotal = (row) => linesOf(row).reduce((sum, line) => sum + qty(line.siteQty) * qty(line.quotedUnitCost), 0);

/** Signed percentage the quoted cost sits from the accepted proposal; null until every line is quoted. */
export const variationPct = (row) => {
    if (!quotesReceived(row)) return null;
    const base = proposalTotal(row);
    if (!base) return 0;
    return ((quotedTotal(row) - base) / base) * 100;
};

/** none | below | above — the chart gates on the size of the move, so a saving counts like a rise. */
export const variationTier = (pct) => {
    if (pct === null || pct === undefined) return null;
    const size = Math.abs(pct);
    if (size < 0.005) return "none";
    return size < VARIATION_ESCALATION_PERCENT ? "below" : "above";
};

export const requiredApprovers = (row) => {
    const pct = variationPct(row);
    const tier = variationTier(pct);
    if (!tier || tier === "none") return [];
    return variationApproverRoles(pct);
};

const approvalFor = (row, role) => approvalsOf(row).find((entry) => entry.role === role) ?? null;
export const pendingApprovers = (row) => requiredApprovers(row).filter((role) => approvalFor(row, role)?.status !== "approved");
/** True once the job may place orders: every line quoted and no variation, or every approval in. */
export const readyToOrder = (row) => quotesReceived(row) && pendingApprovers(row).length === 0;
const roleName = (role) => APPROVER_ROLES[role] ?? role;

/**
 * When a checklist counts as complete, by its required items — the same
 * answers the frontend's definition asks for (constants/procurementChecklists.js),
 * so the gate here and the tick on screen agree.
 */
const SECTION_DONE = {
    boq: (a) => ["boqMatches", "materialsIncluded", "quantitiesCorrect", "siteRequirementsIncluded", "changesApproved"].every((key) => a[key] === true) && !blank(a.changesApprovedDetails),
    quote: (a) =>
        ["quoteCurrentConfirmed", "supplierApproved", "quoteMatchesBoq", "quotesCompared", "pricingConfirmed", "stockConfirmed", "termsConfirmed"].every((key) => a[key] === true) &&
        hasFiles(a.quoteFile) && hasFiles(a.finalQuoteFile) && !blank(a.comparedSuppliers) && !blank(a.fulfilmentMethod) && !blank(a.fulfilmentDate) && !blank(a.fulfilmentTime) &&
        isNumber(a.freightCharges) && !blank(a.paymentDueDate),
    po: (a, row) =>
        ["basisConfirmed", "poAmountMatches", "variationChecked", "supplierConfirmed", "deliveryConfirmed", "termsConfirmed", "releaseApproved", "poReleasedConfirmed"].every((key) => a[key] === true) &&
        isNumber(a.poAmountValue) && hasFiles(a.poRecords) && (requiredApprovers(row).length === 0 || a.variationApproved === true),
    receipt: (a) =>
        ["matchesPo", "specsCorrect", "quantitiesMatch", "damageChecked", "allArrived", "materialsReady", "recordsUpdated"].every((key) => a[key] === true) &&
        hasFiles(a.receiptFiles) &&
        (a.discrepancyFound === "no" || (a.discrepancyFound === "yes" && !blank(a.discrepancyDetails) && a.supplierNotified === true && a.replacementArranged === true)),
    jobCreation: (a) => !blank(a.greenDealJobId) && a.syncConfirmed === true && a.matchConfirmed === true,
};
export const sectionComplete = (row, section) => Boolean(SECTION_DONE[section]?.(answersOf(row, section), row));

// ---- Seeding the BOQ from the accepted quote -----------------------------------------

/**
 * The accepted quote's items as BOQ / BOS lines: what was proposed is also
 * what the site needs until the coordinator says otherwise, and nothing is
 * quoted yet. Line keys stay stable across rounds, so revisions and purchase
 * orders can name them.
 */
const linesFromSnapshot = (snapshot) => {
    const items = Array.isArray(snapshot?.quote?.items) ? snapshot.quote.items : Array.isArray(snapshot?.items) ? snapshot.items : [];
    const seen = new Map();
    return items.slice(0, MAX_LINES).map((item, index) => {
        const base = (oneLine(item?.itemKey || item?.itemName, 60) || `line_${index + 1}`).replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || `line_${index + 1}`;
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        const quantity = num(item?.quantity) ?? 1;
        const unitPrice = num(item?.unitPrice) ?? 0;
        const discount = num(item?.discountPct) ?? 0;
        return {
            key: n > 1 ? `${base}_${n}` : base,
            kind: SERVICE_PATTERN.test(`${item?.itemKey ?? ""} ${item?.itemName ?? ""}`) ? "service" : "material",
            item: oneLine(item?.itemName, 160) || base,
            brand: oneLine(item?.brand, 120) || null,
            unit: oneLine(item?.unit, 30) || "ea",
            proposalQty: quantity,
            siteQty: quantity,
            proposalUnitCost: Number((unitPrice * (1 - discount / 100)).toFixed(2)),
            quotedUnitCost: null,
            supplier: null,
            availability: "available",
            leadTimeDays: null,
        };
    });
};

/** The job's row, created from the accepted quote when it does not exist yet (a job that reached the stage before this existed). */
const ensureJob = async (opportunity, actor = null) => {
    const existing = await ProcurementJob.findOne({ where: { opportunityId: opportunity.id } });
    if (existing) return existing;
    const accepted = (await acceptedProposalsFor([opportunity.id])).get(opportunity.id) ?? null;
    const row = await ProcurementJob.create({
        opportunityId: opportunity.id,
        boq: linesFromSnapshot(accepted?.quoteVersion?.snapshot),
        enteredAt: opportunity.stage === PROCUREMENT_STAGE ? opportunity.slaStartedAt ?? new Date() : new Date(),
    });
    await recordSystemEvent(
        opportunity,
        `Entered Procurement & delivery — BOQ of ${linesOf(row).length} line${linesOf(row).length === 1 ? "" : "s"} from ${accepted ? `the accepted ${accepted.quoteVersion?.quoteNumber || "quote"} v${accepted.quoteVersion?.version ?? ""}`.trim() : "no accepted quote — add the lines by hand"}`,
        actor
    );
    return row;
};

const loadJob = async (id, actor = null) => {
    const opportunity = await loadOpportunity(id);
    if (opportunity.stage < PROCUREMENT_STAGE) throw httpError(400, "This job has not reached procurement & delivery yet");
    const row = await ensureJob(opportunity, actor);
    return { opportunity, row };
};

// ---- Entering the stage -----------------------------------------------------------

/**
 * The job has just moved to procurement (called by moveToNextStage): seed its
 * BOQ from the accepted quote and tell the operations coordinators there is a
 * BOQ to verify. Procurement itself heard from the approvals gate.
 */
export const enterProcurement = async (opportunity, actor = null) => {
    const row = await ensureJob(opportunity, actor);
    await notify({
        event: "procurement.started",
        title: `${opportunity.number}: procurement — BOQ to verify`,
        body: `${customerLabel(opportunity)} — ${linesOf(row).length} line${linesOf(row).length === 1 ? "" : "s"} from the accepted quote. Check them against the site, get quotes and work the checklists on the procurement page.`,
        roleCode: OPERATIONS_COORDINATOR_ROLE,
        userIds: [opportunity.operationalCoordinatorId],
        opportunity,
        actor,
        includeActor: true,
    });
    return row;
};

// ---- Presenting -------------------------------------------------------------------

const presentPurchaseOrder = (po) => ({
    id: po.id,
    number: po.ref,
    supplier: po.supplier,
    status: po.status,
    lines: Array.isArray(po.lines) ? po.lines : [],
    total: num(po.amount),
    sentAt: po.sentAt,
    deliveryEta: po.eta,
    scheduledFor: po.scheduledFor,
    deliveredAt: po.deliveredAt,
    receivedBy: po.receivedBy,
    createdById: po.createdById,
    createdAt: po.createdAt,
});

/** "Estimator assigned — Jane" → { action, detail }; the history tab shows both lines. */
const presentHistory = (row) => {
    const [action, ...rest] = String(row.note ?? "").split(" — ");
    return { at: row.createdAt, by: row.author?.name ?? "System", action, detail: rest.join(" — ") || null };
};
const presentNotice = (row) => ({ at: row.createdAt, rule: row.event, to: row.user?.name ?? "—", priority: row.priority, message: row.body || row.title });

/** The history and the stage's notices of several jobs in two queries, newest first and capped per job. */
const historyAndNoticesFor = async (opportunityIds) => {
    const [history, notices] = await Promise.all([
        OpportunityHistory.findAll({
            where: { opportunityId: { [Op.in]: opportunityIds } },
            include: [{ model: User, as: "author", attributes: ["id", "name"] }],
            order: [["createdAt", "DESC"], ["id", "DESC"]],
            limit: PER_JOB_LIMIT * opportunityIds.length,
        }),
        Notification.findAll({
            where: { opportunityId: { [Op.in]: opportunityIds }, event: { [Op.like]: "procurement.%" } },
            include: [{ model: User, as: "user", attributes: ["id", "name"] }],
            order: [["createdAt", "DESC"], ["id", "DESC"]],
            limit: PER_JOB_LIMIT * opportunityIds.length,
        }),
    ]);
    const perJob = (list, present) => {
        const byOpp = new Map();
        for (const entry of list) {
            const held = byOpp.get(entry.opportunityId) ?? [];
            if (held.length < PER_JOB_LIMIT) held.push(present(entry));
            byOpp.set(entry.opportunityId, held);
        }
        return byOpp;
    };
    return { history: perJob(history, presentHistory), notifications: perJob(notices, presentNotice) };
};

/**
 * One job as the procurement screens read it (prestige-fe helpers/procurement.js
 * works the rules over this shape): the record, its BOQ and rounds, quotes,
 * approvals, purchase orders, the Green Deal job, the checklist answers, and
 * the history and notices behind it.
 */
const presentJob = (opportunity, row, { purchaseOrders = [], people = new Map(), accepted = null, history = [], notifications = [] }) => {
    const pct = variationPct(row);
    const greenDeal = isPlainObject(row.greenDeal) && row.greenDeal.created ? row.greenDeal : { created: false };
    return {
        id: opportunity.id,
        number: opportunity.number,
        stage: opportunity.stage,
        lifecycle: opportunity.lifecycle,
        customer: customerLabel(opportunity),
        site: siteOf(opportunity),
        acceptedValue: num(accepted?.grandTotal) ?? num(opportunity.acceptedValue) ?? (proposalTotal(row) || null),
        salespersonId: opportunity.salespersonId,
        salesperson: people.get(opportunity.salespersonId)?.name ?? null,
        coordinatorId: opportunity.operationalCoordinatorId,
        coordinator: people.get(opportunity.operationalCoordinatorId)?.name ?? null,
        enteredAt: row.enteredAt,
        slaDueAt: opportunity.stage === PROCUREMENT_STAGE ? opportunity.slaDueAt : null,
        revisions: revisionsOf(row),
        boq: linesOf(row),
        quotes: quotesOf(row),
        approvals: approvalsOf(row),
        purchaseOrders: purchaseOrders.map(presentPurchaseOrder),
        greenDeal,
        checklist: checklistOf(row),
        // The API's own reading of the rules, so a client need not recompute them.
        variation: {
            proposalTotal: proposalTotal(row),
            quotedTotal: quotesReceived(row) ? quotedTotal(row) : null,
            pct,
            tier: variationTier(pct),
            approvers: requiredApprovers(row),
            pending: pendingApprovers(row),
            readyToOrder: readyToOrder(row),
        },
        sections: Object.fromEntries(CHECKLIST_SECTIONS.map((section) => [section, sectionComplete(row, section)])),
        history,
        notifications,
    };
};

const peopleFor = async (opportunities) => {
    const ids = [...new Set(opportunities.flatMap((o) => [o.salespersonId, o.operationalCoordinatorId]).filter(Boolean))];
    const users = ids.length ? await User.findAll({ where: { id: { [Op.in]: ids } }, attributes: ["id", "name"] }) : [];
    return new Map(users.map((user) => [user.id, user]));
};

const purchaseOrdersFor = (opportunityIds) =>
    PurchaseOrder.findAll({ where: { opportunityId: { [Op.in]: opportunityIds } }, order: [["id", "ASC"]] });

const presentOne = async (opportunity, row) => {
    const [pos, people, accepted, { history, notifications }] = await Promise.all([
        purchaseOrdersFor([opportunity.id]),
        peopleFor([opportunity]),
        acceptedProposalsFor([opportunity.id]),
        historyAndNoticesFor([opportunity.id]),
    ]);
    return presentJob(opportunity, row, {
        purchaseOrders: pos,
        people,
        accepted: accepted.get(opportunity.id) ?? null,
        history: history.get(opportunity.id) ?? [],
        notifications: notifications.get(opportunity.id) ?? [],
    });
};

/** The job's procurement record, with everything the screens show. */
export const getProcurementJob = async (id, actor = null) => {
    const { opportunity, row } = await loadJob(id, actor);
    return presentOne(await Opportunity.findByPk(opportunity.id), row);
};

/**
 * Where a job is in the stage (mirrors prestige-fe helpers/procurement.js
 * currentStep): no lines → verify the BOQ; not every line quoted → getting
 * quotes; a variation still to clear → approvals; nothing sent yet → orders;
 * then Green Deal, then done.
 */
const stepOf = (row, orders) => {
    if (!linesOf(row).length) return "boq";
    if (!quotesReceived(row)) return "matching";
    if (!readyToOrder(row)) return "approvals";
    if (!orders.some((po) => po.status !== "draft")) return "delivery";
    return isPlainObject(row.greenDeal) && row.greenDeal.created ? "done" : "green_deal";
};

/**
 * The procurement page, a page at a time: every active job at the stage,
 * plus jobs that moved on in the last 30 days (so "ready for construction"
 * does not vanish the moment it is), narrowed to the stages the person may
 * read — newest first, the job that reached procurement most recently at the
 * top. `counts` carries the stat cards across the whole board: jobs at the
 * stage, jobs awaiting a variation approval, purchase orders sent, Green Deal
 * jobs created. Each row is the whole job, so opening one asks for nothing
 * more; its history and notices are only looked up for the rows on the page.
 */
export const procurementBoard = async (query = {}, actor) => {
    const paging = pagingOf(query);
    const unitId = parseId(query.businessUnitId, "business unit id");
    const allowed = await readableStages(actor);
    const since = new Date(Date.now() - 30 * 86400000);
    const matching = searchCondition(query.search);
    const opportunities = await Opportunity.findAll({
        where: {
            businessUnitId: unitId,
            lifecycle: "Active",
            stage: { [Op.in]: allowed.length ? allowed : [0] },
            [Op.and]: [
                { [Op.or]: [{ stage: PROCUREMENT_STAGE }, { stage: { [Op.gt]: PROCUREMENT_STAGE }, slaStartedAt: { [Op.gte]: since } }] },
                ...(matching ? [matching] : []),
            ],
        },
        limit: 1000,
    });
    const counts = { all: 0, inStage: 0, awaitingApproval: 0, purchaseOrders: 0, greenDeal: 0 };
    const empty = (total) => ({ rows: [], total, page: paging.page, pageSize: paging.pageSize, counts });
    if (!opportunities.length) return empty(0);

    const ids = opportunities.map((o) => o.id);
    const [records, allOrders] = await Promise.all([ProcurementJob.findAll({ where: { opportunityId: { [Op.in]: ids } } }), purchaseOrdersFor(ids)]);
    const rows = new Map(records.map((row) => [row.opportunityId, row]));
    // A job at the stage with no record yet (it got here before this existed) gets one now.
    for (const opportunity of opportunities) if (!rows.has(opportunity.id) && opportunity.stage === PROCUREMENT_STAGE) rows.set(opportunity.id, await ensureJob(opportunity, actor));
    const ordersOf = new Map();
    for (const po of allOrders) ordersOf.set(po.opportunityId, [...(ordersOf.get(po.opportunityId) ?? []), po]);
    const listed = opportunities
        .filter((o) => rows.has(o.id))
        // Newest first: the job that reached procurement most recently at the top.
        .sort(newestFirst((o) => rows.get(o.id).enteredAt ?? o.slaStartedAt ?? o.createdAt));
    for (const opportunity of listed) {
        const row = rows.get(opportunity.id);
        const orders = ordersOf.get(opportunity.id) ?? [];
        counts.all += 1;
        if (opportunity.stage === PROCUREMENT_STAGE) {
            counts.inStage += 1;
            if (stepOf(row, orders) === "approvals") counts.awaitingApproval += 1;
        }
        counts.purchaseOrders += orders.filter((po) => po.status !== "draft").length;
        if (isPlainObject(row.greenDeal) && row.greenDeal.created) counts.greenDeal += 1;
    }

    const onPage = pageOf(listed, paging);
    if (!onPage.length) return empty(listed.length);
    const pageIds = onPage.map((o) => o.id);
    const [people, accepted, { history, notifications }] = await Promise.all([peopleFor(onPage), acceptedProposalsFor(pageIds), historyAndNoticesFor(pageIds)]);
    return {
        rows: onPage.map((opportunity) =>
            presentJob(opportunity, rows.get(opportunity.id), {
                purchaseOrders: ordersOf.get(opportunity.id) ?? [],
                people,
                accepted: accepted.get(opportunity.id) ?? null,
                history: history.get(opportunity.id) ?? [],
                notifications: notifications.get(opportunity.id) ?? [],
            })
        ),
        total: listed.length,
        page: paging.page,
        pageSize: paging.pageSize,
        counts,
    };
};

// ---- Quotes in, variation out: the approvals -----------------------------------------

/**
 * Every line is quoted: measure the variation and, when there is one, ask the
 * people who have to approve it — the sales manager under the threshold, the
 * owner as well from it. Called whenever the quoted costs change, so a re-quote
 * that crosses the threshold adds the owner without losing the manager's answer.
 */
const syncApprovals = async (opportunity, row, actor, { announce = false } = {}) => {
    if (!quotesReceived(row)) return;
    const pct = variationPct(row);
    const tier = variationTier(pct);
    const required = requiredApprovers(row);
    if (announce) {
        await recordSystemEvent(
            opportunity,
            tier === "none"
                ? `Quotes received — ${money(quotedTotal(row))} against ${money(proposalTotal(row))} proposed: no price variation, purchase orders can go out`
                : `Quotes received — ${money(quotedTotal(row))} against ${money(proposalTotal(row))} proposed: variation ${signedPct(pct)} (${tier === "below" ? "below" : "at or above"} ${VARIATION_ESCALATION_PERCENT}%)`,
            actor
        );
    }
    const missing = required.filter((role) => !approvalFor(row, role));
    if (!missing.length) return;
    const now = new Date().toISOString();
    const approvals = [...approvalsOf(row), ...missing.map((role) => ({ role, approverId: null, approver: null, status: "pending", requestedAt: now, decidedAt: null, note: null }))];
    await row.update({ approvals });
    await recordSystemEvent(
        opportunity,
        `Approvals requested — ${tier === "below" ? `below ${VARIATION_ESCALATION_PERCENT}%` : `${VARIATION_ESCALATION_PERCENT}% or more`}: ${missing.map(roleName).join(" and ")}`,
        actor
    );
    for (const role of missing)
        await notify({
            event: "procurement.variation.approval_requested",
            title: `${opportunity.number}: price variation of ${signedPct(pct)} needs your approval`,
            body: `${customerLabel(opportunity)} — suppliers quoted ${money(quotedTotal(row))} against ${money(proposalTotal(row))} in the accepted proposal. Approve or decline it on the procurement page.`,
            roleCode: role,
            opportunity,
            actor,
            includeActor: true,
        });
};

/** A daily nudge to whoever still has a variation to decide on — the chart's "frequent high-priority notifications". */
export const remindPendingApprovals = async () => {
    const rows = await ProcurementJob.findAll({ include: [{ model: Opportunity, as: "opportunity", attributes: ["id", "number", "businessUnitId", "stage", "lifecycle", "customerLegalName", "customerTradingName"] }] });
    const today = new Date().toISOString().slice(0, 10);
    let raised = 0;
    for (const row of rows) {
        const opportunity = row.opportunity;
        if (!opportunity || opportunity.stage !== PROCUREMENT_STAGE || opportunity.lifecycle !== "Active") continue;
        for (const role of pendingApprovers(row)) {
            const entry = approvalFor(row, role);
            if (!entry || entry.status !== "pending") continue;
            const days = Math.max(1, Math.round((Date.now() - new Date(entry.requestedAt).getTime()) / 86400000));
            const { created } = await notify({
                event: "procurement.variation.reminder",
                title: `${opportunity.number}: price variation approval outstanding for ${days} day${days === 1 ? "" : "s"}`,
                body: `${customerLabel(opportunity)} — the purchase orders are held until the ${roleName(role).toLowerCase()} approves the variation of ${signedPct(variationPct(row))}.`,
                roleCode: role,
                opportunity,
                dedupeKey: `procurement-approval:${opportunity.id}:${role}:${today}`,
            });
            raised += created;
        }
    }
    return raised;
};

/**
 * POST /:id/procurement/approvals/:role/decision — { outcome: approved | rejected, note? }
 * The sales manager or the business owner answering for the variation; ADM
 * may answer for either. Every required role must approve before orders go.
 */
export const decideVariation = async (id, role, payload = {}, actor) => {
    const code = String(role ?? "").toUpperCase();
    if (!APPROVER_ROLES[code]) throw httpError(400, `role must be one of: ${Object.keys(APPROVER_ROLES).join(", ")}`);
    const { opportunity, row } = await loadJob(id, actor);
    if (!quotesReceived(row)) throw httpError(400, "The variation is measured once every line is quoted — nothing to decide yet");
    if (!requiredApprovers(row).includes(code)) throw httpError(400, `This variation does not need the ${roleName(code).toLowerCase()}'s approval`);
    if (!isSuper(actor) && !(Array.isArray(actor?.roles) && actor.roles.includes(code)))
        throw httpError(403, `Only the ${roleName(code).toLowerCase()} can decide this approval`);
    if (!["approved", "rejected"].includes(payload.outcome)) throw httpError(400, "outcome must be approved or rejected");
    const note = multiLine(payload.note, 2000) || null;
    if (payload.outcome === "rejected" && !note) throw httpError(400, "Say why the variation is not approved (note)");

    const now = new Date().toISOString();
    const existing = approvalFor(row, code);
    const entry = { role: code, approverId: actor.id, approver: actor.name, status: payload.outcome, requestedAt: existing?.requestedAt ?? now, decidedAt: now, note };
    const approvals = existing ? approvalsOf(row).map((candidate) => (candidate.role === code ? entry : candidate)) : [...approvalsOf(row), entry];
    await row.update({ approvals });

    const pct = variationPct(row);
    const approved = payload.outcome === "approved";
    await recordSystemEvent(
        opportunity,
        `${roleName(code)} ${approved ? "approved" : "did not approve"} the price variation of ${signedPct(pct)}${note ? ` — ${note}` : ""}`,
        actor
    );
    await notify({
        event: "procurement.variation.decided",
        title: `${opportunity.number}: variation ${approved ? "approved" : "not approved"} by the ${roleName(code).toLowerCase()}`,
        body: `${customerLabel(opportunity)} — ${actor.name} ${approved ? "approved" : "declined"} the price variation of ${signedPct(pct)}${note ? `: ${note}` : "."}`,
        roleCode: PROCUREMENT_ROLE,
        userIds: [opportunity.operationalCoordinatorId, ...(approved ? [] : [opportunity.salespersonId])],
        opportunity,
        actor,
        priority: approved ? undefined : "high",
    });
    if (approved && pendingApprovers(row).length === 0) {
        await recordSystemEvent(opportunity, "All approvals received — purchase orders can be released", actor);
        await notify({
            event: "procurement.approvals.complete",
            title: `${opportunity.number}: variation approved — release the purchase orders`,
            body: `${customerLabel(opportunity)} — every approval the price variation needed is in. Release the purchase orders from the procurement page.`,
            roleCode: OPERATIONS_COORDINATOR_ROLE,
            userIds: [opportunity.operationalCoordinatorId],
            opportunity,
            actor,
            includeActor: true,
        });
    }
    return presentOne(opportunity, row);
};

// ---- The BOQ and its rounds ----------------------------------------------------------

const cleanLineKey = (value) => oneLine(value, 60).replace(/[^A-Za-z0-9_-]+/g, "_");

/**
 * PUT /:id/procurement/boq — the coordinator's verification of the BOQ against
 * the site: per line the quantity the site needs, the supplier, availability
 * and lead time, and the price quoted. body:
 *   { lines: [{ key, siteQty?, quotedUnitCost?, supplier?, availability?, leadTimeDays? }],
 *     add?: [{ item, brand?, unit?, kind?, siteQty, quotedUnitCost?, supplier?, availability?, leadTimeDays? }],
 *     remove?: [key], revise?: boolean, reason? }
 * `revise` closes the round: the lines as they stand go into the revisions and
 * the site figures become the new proposal quantities, matched again. The
 * price variation is still measured from round 1.
 */
export const updateBoq = async (id, payload = {}, actor) => {
    const { opportunity, row } = await loadJob(id, actor);
    const wasQuoted = quotesReceived(row);
    let lines = linesOf(row).map((line) => ({ ...line }));

    const changes = Array.isArray(payload.lines) ? payload.lines : [];
    if (changes.length > MAX_LINES) throw httpError(400, `At most ${MAX_LINES} lines`);
    const applyFields = (line, change) => {
        if (change.siteQty !== undefined) line.siteQty = nonNegative(change.siteQty, "siteQty");
        if (change.quotedUnitCost !== undefined) line.quotedUnitCost = change.quotedUnitCost === null || change.quotedUnitCost === "" ? null : nonNegative(change.quotedUnitCost, "quotedUnitCost");
        if (change.supplier !== undefined) line.supplier = oneLine(change.supplier, 120) || null;
        if (change.availability !== undefined) {
            if (!AVAILABILITY.includes(change.availability)) throw httpError(400, `availability must be one of: ${AVAILABILITY.join(", ")}`);
            line.availability = change.availability;
        }
        if (change.leadTimeDays !== undefined) line.leadTimeDays = change.leadTimeDays === null || change.leadTimeDays === "" ? null : Math.round(nonNegative(change.leadTimeDays, "leadTimeDays"));
        return line;
    };
    for (const change of changes) {
        const line = lines.find((candidate) => candidate.key === change?.key);
        if (!line) throw httpError(400, `Unknown BOQ line: ${change?.key}`);
        applyFields(line, change);
    }

    // Lines discovered on site beyond the original quote (PRC-02): nothing was
    // proposed for them, so they are a variation in full.
    const added = Array.isArray(payload.add) ? payload.add : [];
    const keys = new Set(lines.map((line) => line.key));
    for (const [index, entry] of added.entries()) {
        const item = oneLine(entry?.item, 160);
        if (!item) throw httpError(400, "Each added line needs an item name");
        let key = cleanLineKey(entry.key || item.toLowerCase()) || `line_${lines.length + index + 1}`;
        for (let n = 2; keys.has(key); n += 1) key = `${cleanLineKey(entry.key || item.toLowerCase()).slice(0, 56)}_${n}`;
        keys.add(key);
        lines.push(
            applyFields(
                {
                    key,
                    kind: LINE_KINDS.includes(entry.kind) ? entry.kind : SERVICE_PATTERN.test(item) ? "service" : "material",
                    item,
                    brand: oneLine(entry.brand, 120) || null,
                    unit: oneLine(entry.unit, 30) || "ea",
                    proposalQty: 0,
                    siteQty: 0,
                    proposalUnitCost: 0,
                    quotedUnitCost: null,
                    supplier: null,
                    availability: "available",
                    leadTimeDays: null,
                },
                { siteQty: entry.siteQty ?? 0, ...entry }
            )
        );
    }
    if (lines.length > MAX_LINES) throw httpError(400, `A BOQ holds at most ${MAX_LINES} lines`);
    const removed = Array.isArray(payload.remove) ? payload.remove.map(String) : [];
    if (removed.length) {
        // Only a line added on site can go; the quote's own lines stay (zero the site quantity instead).
        for (const key of removed) {
            const line = lines.find((candidate) => candidate.key === key);
            if (!line) throw httpError(400, `Unknown BOQ line: ${key}`);
            if (originalLines(row).some((candidate) => candidate.key === key) && qty(line.proposalQty) > 0)
                throw httpError(400, `${line.item} came from the accepted quote — set its site quantity to 0 rather than removing it`);
        }
        lines = lines.filter((line) => !removed.includes(line.key));
    }

    let revisions = revisionsOf(row);
    if (payload.revise) {
        const reason = multiLine(payload.reason, 2000);
        if (!reason) throw httpError(400, "Say why the BOQ is being revised (reason)");
        const mismatch = lines.filter((line) => qty(line.proposalQty) !== qty(line.siteQty));
        if (!mismatch.length) throw httpError(400, "Every line already matches the site — there is nothing to revise");
        revisions = [...revisions, { round: revisions.length + 1, at: new Date().toISOString(), byId: actor?.id ?? null, by: actor?.name ?? "System", reason, lines }];
        lines = lines.map((line) => ({ ...line, proposalQty: line.siteQty }));
        await recordSystemEvent(
            opportunity,
            `BOQ revised — round ${revisions.length + 1}: ${mismatch.map((line) => `${line.item} ${qty(line.proposalQty)} → ${qty(line.siteQty)} ${line.unit}`).join(", ")}. ${reason}`,
            actor
        );
    }

    await row.update({ boq: lines, revisions });
    if (!wasQuoted && quotesReceived(row)) await syncApprovals(opportunity, row, actor, { announce: true });
    else if (quotesReceived(row)) await syncApprovals(opportunity, row, actor);
    return presentOne(opportunity, row);
};

// ---- Supplier quotes ------------------------------------------------------------------

/** POST /:id/procurement/quotes — { supplier, total, validUntil?, receivedAt?, note? } */
export const addQuote = async (id, payload = {}, actor) => {
    const { opportunity, row } = await loadJob(id, actor);
    const supplier = oneLine(payload.supplier, 120);
    if (!supplier) throw httpError(400, "supplier is required");
    const total = nonNegative(payload.total, "total");
    const quote = {
        supplier,
        total,
        validUntil: dateOnly(payload.validUntil, "validUntil"),
        receivedAt: (parseDate(payload.receivedAt, "receivedAt") ?? new Date()).toISOString(),
        note: multiLine(payload.note, 1000) || null,
        byId: actor?.id ?? null,
    };
    const quotes = [...quotesOf(row), quote];
    if (quotes.length > 50) throw httpError(400, "At most 50 quotes on a job");
    await row.update({ quotes });
    await recordSystemEvent(opportunity, `Quote received — ${supplier}, ${money(total)}${quote.validUntil ? `, valid until ${quote.validUntil}` : ""}`, actor);
    return presentOne(opportunity, row);
};

/** DELETE /:id/procurement/quotes/:index — a quote recorded in error. */
export const removeQuote = async (id, index, actor) => {
    const { opportunity, row } = await loadJob(id, actor);
    const at = Number(index);
    const quotes = quotesOf(row);
    if (!Number.isInteger(at) || at < 0 || at >= quotes.length) throw httpError(404, "Quote not found");
    const [gone] = quotes.splice(at, 1);
    await row.update({ quotes: [...quotes] });
    await recordSystemEvent(opportunity, `Quote removed — ${gone.supplier}, ${money(gone.total)}`, actor);
    return presentOne(opportunity, row);
};

// ---- Purchase orders --------------------------------------------------------------------

/** PO-26-0112: the year, then a running number across every unit. */
const nextPurchaseOrderNumber = async () => {
    const count = await PurchaseOrder.count();
    return `PO-${String(new Date().getFullYear()).slice(-2)}-${String(count + 1).padStart(4, "0")}`;
};

const loadPurchaseOrder = async (opportunity, poId) => {
    const po = await PurchaseOrder.findOne({ where: { id: parseId(poId, "purchase order id"), opportunityId: opportunity.id } });
    if (!po) throw httpError(404, "Purchase order not found");
    return po;
};

const cleanPoLines = (row, value) => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) throw httpError(400, "lines must be a list of BOQ line keys");
    const known = new Set(linesOf(row).map((line) => line.key));
    const keys = [...new Set(value.map(String))];
    const unknown = keys.filter((key) => !known.has(key));
    if (unknown.length) throw httpError(400, `Unknown BOQ line${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`);
    return keys;
};

const quotedCostOf = (row, keys) => linesOf(row).filter((line) => keys.includes(line.key)).reduce((sum, line) => sum + qty(line.siteQty) * qty(line.quotedUnitCost), 0);

const heldMessage = (row) =>
    quotesReceived(row)
        ? `Purchase orders are held until ${pendingApprovers(row).map((role) => roleName(role).toLowerCase()).join(" and ")} approve${pendingApprovers(row).length === 1 ? "s" : ""} the price variation`
        : "Purchase orders go out once every BOQ line is quoted";

/** POST /:id/procurement/purchase-orders — { supplier, lines, total?, deliveryEta? } → a draft, numbered by the API. */
export const createPurchaseOrder = async (id, payload = {}, actor) => {
    const { opportunity, row } = await loadJob(id, actor);
    const supplier = oneLine(payload.supplier, 120);
    if (!supplier) throw httpError(400, "supplier is required");
    const lines = cleanPoLines(row, payload.lines ?? []) ?? [];
    if (!lines.length) throw httpError(400, "Pick at least one BOQ line for the order");
    const total = payload.total === undefined || payload.total === null || payload.total === "" ? quotedCostOf(row, lines) : nonNegative(payload.total, "total");
    const po = await PurchaseOrder.create({
        opportunityId: opportunity.id,
        ref: await nextPurchaseOrderNumber(),
        supplier,
        lines,
        amount: total,
        eta: dateOnly(payload.deliveryEta, "deliveryEta"),
        status: "draft",
        createdById: actor?.id ?? null,
    });
    await recordSystemEvent(opportunity, `Purchase order drafted — ${po.ref} to ${supplier}, ${money(total)}`, actor);
    return presentOne(opportunity, row);
};

/**
 * PATCH /:id/procurement/purchase-orders/:poId — { supplier?, lines?, total?, deliveryEta?,
 *   status?, sentAt?, scheduledFor?, deliveredAt?, receivedBy? }
 * Sending needs the variation cleared; scheduling needs a date; receiving stamps who and when.
 */
export const updatePurchaseOrder = async (id, poId, payload = {}, actor) => {
    const { opportunity, row } = await loadJob(id, actor);
    const po = await loadPurchaseOrder(opportunity, poId);
    const fields = {};
    if (payload.supplier !== undefined) {
        const supplier = oneLine(payload.supplier, 120);
        if (!supplier) throw httpError(400, "supplier cannot be blank");
        fields.supplier = supplier;
    }
    const lines = cleanPoLines(row, payload.lines);
    if (lines !== undefined) {
        if (!lines.length) throw httpError(400, "An order covers at least one BOQ line");
        fields.lines = lines;
    }
    if (payload.total !== undefined) fields.amount = nonNegative(payload.total, "total");
    if (payload.deliveryEta !== undefined) fields.eta = dateOnly(payload.deliveryEta, "deliveryEta");
    if (payload.scheduledFor !== undefined) fields.scheduledFor = dateOnly(payload.scheduledFor, "scheduledFor");
    if (payload.receivedBy !== undefined) fields.receivedBy = oneLine(payload.receivedBy, 120) || null;

    const events = [];
    if (payload.status !== undefined && payload.status !== po.status) {
        const status = payload.status;
        if (!PURCHASE_ORDER_STATUSES.includes(status)) throw httpError(400, `status must be one of: ${PURCHASE_ORDER_STATUSES.join(", ")}`);
        if (status === "draft") throw httpError(400, "An order that has gone to the supplier cannot go back to draft");
        if (po.status === "draft" && !readyToOrder(row)) throw httpError(400, heldMessage(row));
        if (po.status === "draft") {
            fields.sentAt = parseDate(payload.sentAt, "sentAt") ?? new Date();
            events.push(`Purchase order sent — ${po.ref} to ${fields.supplier ?? po.supplier}, ${money(fields.amount ?? po.amount)}`);
        }
        if (status === "confirmed") fields.confirmedAt = fields.confirmedAt ?? po.confirmedAt ?? new Date();
        if (status === "scheduled") {
            const slot = fields.scheduledFor ?? po.scheduledFor;
            if (!slot) throw httpError(400, "Give the delivery date (scheduledFor) to schedule the order");
            events.push(`Delivery scheduled — ${po.ref} for ${slot}`);
        }
        if (status === "delivered") {
            fields.deliveredAt = parseDate(payload.deliveredAt, "deliveredAt") ?? new Date();
            fields.receivedBy = fields.receivedBy ?? po.receivedBy ?? actor?.name ?? null;
            events.push(`Delivery received — ${po.ref} from ${fields.supplier ?? po.supplier}${fields.receivedBy ? `, signed for by ${fields.receivedBy}` : ""}`);
        }
        fields.status = status;
    } else if (payload.deliveredAt !== undefined) fields.deliveredAt = parseDate(payload.deliveredAt, "deliveredAt");

    if (!Object.keys(fields).length) throw httpError(400, "Nothing to change");
    await po.update(fields);
    for (const note of events) await recordSystemEvent(opportunity, note, actor);
    if (!events.length) await recordSystemEvent(opportunity, `Purchase order updated — ${po.ref}`, actor);
    return presentOne(opportunity, row);
};

/** DELETE /:id/procurement/purchase-orders/:poId — drafts only; a sent order is history. */
export const deletePurchaseOrder = async (id, poId, actor) => {
    const { opportunity, row } = await loadJob(id, actor);
    const po = await loadPurchaseOrder(opportunity, poId);
    if (po.status !== "draft") throw httpError(400, "Only a draft order can be removed — one that has gone to the supplier stays on record");
    await po.destroy();
    await recordSystemEvent(opportunity, `Purchase order removed — ${po.ref} (draft)`, actor);
    return presentOne(opportunity, row);
};

// ---- The checklists ---------------------------------------------------------------------

/** One answer, as the checklist stores it: a tick, a number, text, or a list of files. */
const cleanAnswer = (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string") return value.slice(0, 2000);
    if (Array.isArray(value))
        return value
            .slice(0, 50)
            .map((file) =>
                isPlainObject(file)
                    ? { id: file.id ?? null, filename: oneLine(file.filename, 255) || "file", url: typeof file.url === "string" ? file.url.slice(0, 1000) : null }
                    : null
            )
            .filter(Boolean);
    return null;
};

/**
 * What the checklists settle, applied to the record: approval recorded on
 * CL-13 clears the variation, releasing on CL-13 sends the drafted orders,
 * everything arriving on CL-14 receives them, and CL-10 complete is the Green
 * Deal job. Each goes in the history; the ones other teams wait on notify.
 */
const applyChecklistEffects = async (opportunity, row, section, before, after, actor) => {
    const turnedOn = (key) => after[key] === true && before[key] !== true;
    const name = actor?.name ?? "Operations";

    if (section === "po" && turnedOn("variationApproved")) {
        const now = new Date().toISOString();
        const required = requiredApprovers(row);
        const held = approvalsOf(row);
        const note = `Recorded on CL-13 by ${name}${!blank(after.variationApprovedBy) ? `: ${String(after.variationApprovedBy).slice(0, 200)}` : ""}`;
        const recordedBy = String(after.variationApprovedBy ?? "").slice(0, 120) || null;
        const approvals = [
            ...held.map((entry) => (required.includes(entry.role) && entry.status !== "approved" ? { ...entry, status: "approved", decidedAt: now, note, approver: entry.approver ?? recordedBy } : entry)),
            ...required.filter((role) => !held.some((entry) => entry.role === role)).map((role) => ({ role, approverId: null, approver: recordedBy, status: "approved", requestedAt: now, decidedAt: now, note })),
        ];
        await row.update({ approvals });
        if (required.length) await recordSystemEvent(opportunity, `Variation approval recorded on CL-13 — ${required.map(roleName).join(" and ")}${!blank(after.variationApprovedBy) ? `: ${after.variationApprovedBy}` : ""}`, actor);
    }

    if (section === "po" && turnedOn("poReleasedConfirmed")) {
        const drafts = await PurchaseOrder.findAll({ where: { opportunityId: opportunity.id, status: "draft" } });
        const sentAt = parseDate(after.poReleasedOn, "poReleasedOn") ?? new Date();
        for (const po of drafts) await po.update({ status: "sent", sentAt });
        await recordSystemEvent(
            opportunity,
            drafts.length ? `Purchase orders sent — ${drafts.map((po) => po.ref).join(", ")} (released on CL-13)` : "PO released to supplier — recorded on CL-13",
            actor
        );
    }

    if (section === "receipt" && turnedOn("allArrived")) {
        const open = await PurchaseOrder.findAll({ where: { opportunityId: opportunity.id, status: { [Op.notIn]: ["draft", "delivered"] } } });
        for (const po of open) await po.update({ status: "delivered", deliveredAt: new Date(), receivedBy: po.receivedBy ?? name });
        await recordSystemEvent(opportunity, open.length ? `Deliveries received — ${open.map((po) => po.ref).join(", ")} (all ordered items arrived, CL-14)` : "All ordered items confirmed as arrived (CL-14)", actor);
    }

    if (section === "receipt" && after.discrepancyFound === "yes" && before.discrepancyFound !== "yes") {
        const detail = multiLine(after.discrepancyDetails, 1000);
        await recordSystemEvent(opportunity, `Delivery discrepancy recorded — ${detail || "missing, incorrect or damaged items (details to follow)"}`, actor);
        await notify({
            event: "procurement.delivery.discrepancy",
            title: `${opportunity.number}: delivery missing, incorrect or damaged`,
            body: `${customerLabel(opportunity)} — ${detail || `${name} recorded a discrepancy on the material receipt.`} Notify the supplier and arrange the replacement.`,
            roleCode: PROCUREMENT_ROLE,
            userIds: [opportunity.operationalCoordinatorId],
            opportunity,
            actor,
        });
    }

    if (section === "receipt" && turnedOn("materialsReady")) await recordSystemEvent(opportunity, "Materials confirmed ready before installation booking (CL-14)", actor);

    if (section === "jobCreation") {
        const done = SECTION_DONE.jobCreation(after);
        const wasDone = SECTION_DONE.jobCreation(before);
        if (done && !wasDone) {
            const jobId = String(after.greenDealJobId).trim().slice(0, 60);
            const createdAt = parseDate(after.greenDealCreatedOn, "greenDealCreatedOn") ?? new Date();
            await row.update({ greenDeal: { created: true, jobId, createdAt: createdAt.toISOString(), byId: actor?.id ?? null, by: name } });
            await recordSystemEvent(opportunity, `Green Deal job created — ${jobId}`, actor);
            await notify({
                event: "procurement.green_deal.created",
                title: `${opportunity.number}: Green Deal job ${jobId} created — ready for construction`,
                body: `${customerLabel(opportunity)} — materials ${answersOf(row, "receipt").materialsReady === true ? "are confirmed ready" : "to be confirmed ready"} and the Green Deal job is in. Book the installation.`,
                roleCode: SITE_OPERATIONS_ROLE,
                userIds: [opportunity.operationalCoordinatorId],
                opportunity,
                actor,
                includeActor: true,
            });
            await notify({
                event: "procurement.green_deal.created",
                title: `${opportunity.number}: Green Deal job ${jobId} created — ready for construction`,
                body: `${customerLabel(opportunity)} — the Green Deal job is created and checked against the signed quote.`,
                roleCode: BUSINESS_OPERATIONS_ROLE,
                opportunity,
                actor,
            });
        } else if (!done && wasDone) {
            await row.update({ greenDeal: {} });
            await recordSystemEvent(opportunity, "Green Deal job creation reopened — CL-10 no longer complete", actor);
        }
    }

    // A checklist finished is a step the chart records.
    const complete = SECTION_DONE[section](after, row);
    if (complete && !SECTION_DONE[section](before, row)) await recordSystemEvent(opportunity, `${SECTION_CODES[section]} complete`, actor);
};

/**
 * PATCH /:id/procurement/checklist/:section — { patch: { key: answer } } (or the
 * answers at the top level). Merged into the section's answers; items the
 * Procurement Manager signs need procurement.approve.
 */
export const updateChecklist = async (id, section, payload = {}, actor) => {
    if (!CHECKLIST_SECTIONS.includes(section)) throw httpError(400, `section must be one of: ${CHECKLIST_SECTIONS.join(", ")}`);
    const { opportunity, row } = await loadJob(id, actor);
    const source = isPlainObject(payload?.patch) ? payload.patch : isPlainObject(payload) ? payload : {};
    const entries = Object.entries(source).filter(([key]) => key && key.length <= 60);
    if (!entries.length) throw httpError(400, "Send the answers that changed (patch)");
    if (entries.length > 50) throw httpError(400, "At most 50 answers at a time");
    const clean = Object.fromEntries(entries.map(([key, value]) => [key, cleanAnswer(value)]));

    const managerKeys = MANAGER_KEYS[section] ?? [];
    if (Object.keys(clean).some((key) => managerKeys.includes(key)) && !(await userHasPermission(actor, "procurement.approve")))
        throw httpError(403, "Only the Procurement Manager (procurement.approve) can sign that item");

    const before = answersOf(row, section);
    const after = { ...before, ...clean };
    // The CL-13 release tick is the orders going out, so it waits on the same gate.
    if (section === "po" && after.poReleasedConfirmed === true && before.poReleasedConfirmed !== true && !readyToOrder(row)) throw httpError(400, heldMessage(row));
    if (section === "jobCreation" && SECTION_DONE.jobCreation(after) && !SECTION_DONE.jobCreation(before)) {
        const blocker = jobCreationBlocker(row);
        if (blocker) throw httpError(400, blocker);
    }

    await row.update({ checklist: { ...checklistOf(row), [section]: after } });
    await applyChecklistEffects(opportunity, row, section, before, after, actor);
    return presentOne(opportunity, row);
};

/** Why job creation (CL-10) cannot be completed yet, or null: the variation approval and the material receipt come first. */
const jobCreationBlocker = (row) => {
    const waiting = [];
    const po = answersOf(row, "po");
    if (requiredApprovers(row).length && po.variationApproved !== true && pendingApprovers(row).length) waiting.push("the price-variation approval (PO release)");
    if (!SECTION_DONE.receipt(answersOf(row, "receipt"))) waiting.push("the material receipt");
    return waiting.length ? `Job creation opens once the price-variation approval and material receipt are complete — still waiting on ${waiting.join(" and ")}` : null;
};

// ---- The stage gate -----------------------------------------------------------------------

/**
 * Why the job cannot leave procurement, or null: the materials have to be
 * confirmed ready (CL-14) and the Green Deal job created (CL-10) — the
 * module's exit on the chart.
 */
export const procurementBlocker = async (opportunity) => {
    const row = await ProcurementJob.findOne({ where: { opportunityId: opportunity.id } });
    if (!row) return "Work the procurement checklists before leaving procurement & delivery";
    if (answersOf(row, "receipt").materialsReady !== true) return "Confirm the materials are ready for installation (material receipt, CL-14) before leaving procurement";
    if (!SECTION_DONE.jobCreation(answersOf(row, "jobCreation"))) return "Create the job in Green Deal and confirm it matches the signed quote (CL-10) before leaving procurement";
    return null;
};
