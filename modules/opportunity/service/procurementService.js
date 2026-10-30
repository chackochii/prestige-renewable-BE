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
// so the screen and the API agree on where a job is. Since UAT (Oct 2026) the
// stage itself ends at the PO release: CL-14 and CL-10 are worked from
// construction (stage 7) on the same record — see the stage gates at the end.
//
// A BOQ line: { key, kind: material | service, item, brand, unit, proposalQty,
//   siteQty, inInventory, proposalUnitCost, quotedUnitCost | null, supplier,
//   availability, leadTimeDays }. `inInventory` is set on the BOQ-vs-site tab
//   (we already hold it, so no quote is sought — the FE's quote list leaves it
//   out); the supplier, availability and price come on the supplier-quote tab.
//
// The price-variation approvals are not decided on the procurement screens.
// The coordinator sends each approver a collaboration request of kind
// "approval" (modules/collaboration — department sales for the sales manager,
// admin for the business owner); the approver answers on the request, and the
// collaboration service records the decision here (recordVariationDecision).
// An approval entry: { role, approverId, approver, status: pending | approved |
//   rejected, requestedAt, decidedAt, note, requestId } — requestId is the
//   request it waits on or was decided by (null until one is sent).

import { Op } from "sequelize";
import db from "../../../models/index.js";
import { parseId } from "../../../utils/ids.js";
import { multiLine, oneLine } from "../../../utils/text.js";
import { notify } from "../../notification/service/notificationService.js";
import { userHasPermission } from "../../role/service/roleService.js";
import { OPERATIONS_COORDINATOR_ROLE, recordSystemEvent } from "./leadWorkflowService.js";
import { customerLabel } from "./opportunityPeople.js";
import { searchCondition } from "./opportunityService.js";
import { readableStages } from "./stageAccess.js";
import { VARIATION_ESCALATION_PERCENT, variationApproverRoles } from "./approvalPolicy.js";
import { acceptedProposalsFor, siteOf } from "./approvalsService.js";
import { presentDocument } from "./leadAttachmentService.js";
import { PURCHASE_ORDER_STATUSES } from "../model/purchaseOrder.js";
import { newestFirst, pageOf, pagingOf } from "../../../utils/pagination.js";
import { unitYear2 } from "../../../utils/unitTime.js";

const { Opportunity, BusinessUnit, ProcurementJob, PurchaseOrder, User, OpportunityHistory, Notification, Document } = db;

const httpError = (status, message) => Object.assign(new Error(message), { status });

export const PROCUREMENT_STAGE = 6;
// Construction works the material receipt and the Green Deal job on this record.
export const CONSTRUCTION_STAGE = 7;
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
const money = (value) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(Number(value) || 0);
const signedPct = (pct) => (pct === null || pct === undefined ? "—" : `${pct > 0 ? "+" : ""}${Number(pct).toFixed(1)}%`);
/** How an approval request reads to people (collaborationService.requestLabel, without importing it back). */
const requestCode = (request) => `APR-${request?.id}`;
const asFlag = (value, field) => {
    if (value === null || value === undefined) return false;
    if (typeof value === "boolean") return value;
    if (value === "true" || value === "false") return value === "true";
    throw httpError(400, `${field} must be true or false`);
};

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

/** The job and its record as they are, with no stage check — or null when there is no record yet. */
const findRow = async (id) => {
    const opportunity = await loadOpportunity(id);
    const row = await ProcurementJob.findOne({ where: { opportunityId: opportunity.id } });
    return row ? { opportunity, row } : null;
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

export const approvalFor = (row, role) => approvalsOf(row).find((entry) => entry.role === role) ?? null;
export const pendingApprovers = (row) => requiredApprovers(row).filter((role) => approvalFor(row, role)?.status !== "approved");
/** The approvers the variation needs who have not approved yet. */
export const approvalsComplete = (row) => pendingApprovers(row).length === 0;
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
    // The variation approval is not a tick: it is done when every approver the
    // variation needs has approved on their request (the FE's auto-answered row).
    po: (a, row) =>
        ["basisConfirmed", "poAmountMatches", "variationChecked", "supplierConfirmed", "deliveryConfirmed", "termsConfirmed", "releaseApproved", "poReleasedConfirmed"].every((key) => a[key] === true) &&
        isNumber(a.poAmountValue) && hasFiles(a.poRecords) && approvalsComplete(row),
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
            inInventory: false,
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
    // { reason, at, by } — raised before the approvals were reopened; held until marked reviewed.
    reviewFlag: po.reviewFlag ?? null,
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
const presentJob = (opportunity, row, { purchaseOrders = [], people = new Map(), accepted = null, history = [], notifications = [], fileLinks = new Map() }) => {
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
        checklist: withFileLinks(checklistOf(row), fileLinks),
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

/** { documentId → the address the screens open } for the documents of these jobs. */
const fileLinksFor = async (opportunityIds) => {
    const docs = await Document.findAll({ where: { opportunityId: { [Op.in]: opportunityIds } }, attributes: ["id", "opportunityId", "url", "storageUrl"] });
    return new Map(docs.map((doc) => [doc.id, presentDocument(doc).url]).filter(([, url]) => url));
};

/**
 * The checklist answers with every attached file's link read from its
 * document row. The answers keep { id, filename, url } as they were saved;
 * links saved before files kept their address in the Space carried a token
 * that ran out after two hours, so the stored url is not trusted.
 */
const withFileLinks = (checklist, links) => {
    if (!links.size) return checklist;
    const relink = (value) =>
        Array.isArray(value)
            ? value.map((file) => (isPlainObject(file) && links.has(Number(file.id)) ? { ...file, url: links.get(Number(file.id)) } : file))
            : isPlainObject(value)
              ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, relink(inner)]))
              : value;
    return relink(checklist);
};

const purchaseOrdersFor = (opportunityIds) =>
    PurchaseOrder.findAll({ where: { opportunityId: { [Op.in]: opportunityIds } }, order: [["id", "ASC"]] });

const presentOne = async (opportunity, row) => {
    const [pos, people, accepted, { history, notifications }, fileLinks] = await Promise.all([
        purchaseOrdersFor([opportunity.id]),
        peopleFor([opportunity]),
        acceptedProposalsFor([opportunity.id]),
        historyAndNoticesFor([opportunity.id]),
        fileLinksFor([opportunity.id]),
    ]);
    return presentJob(opportunity, row, {
        purchaseOrders: pos,
        people,
        accepted: accepted.get(opportunity.id) ?? null,
        history: history.get(opportunity.id) ?? [],
        notifications: notifications.get(opportunity.id) ?? [],
        fileLinks,
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
    const [people, accepted, { history, notifications }, fileLinks] = await Promise.all([
        peopleFor(onPage),
        acceptedProposalsFor(pageIds),
        historyAndNoticesFor(pageIds),
        fileLinksFor(pageIds),
    ]);
    return {
        rows: onPage.map((opportunity) =>
            presentJob(opportunity, rows.get(opportunity.id), {
                purchaseOrders: ordersOf.get(opportunity.id) ?? [],
                people,
                accepted: accepted.get(opportunity.id) ?? null,
                history: history.get(opportunity.id) ?? [],
                notifications: notifications.get(opportunity.id) ?? [],
                fileLinks,
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
 * Every line is priced: measure the variation and, when there is one, open an
 * approval entry for each role that has to approve it — the sales manager under
 * the threshold, the owner as well from it — and tell the coordinator to send
 * them their requests. Called whenever the quoted costs change, so a re-quote
 * that crosses the threshold adds the owner without losing the manager's answer.
 * Nobody is asked to decide here: that happens on the approval request the
 * coordinator raises (collaborationService), which lands back in
 * recordVariationDecision.
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
    const approvals = [...approvalsOf(row), ...missing.map((role) => ({ role, approverId: null, approver: null, status: "pending", requestedAt: now, decidedAt: null, note: null, requestId: null }))];
    await row.update({ approvals });
    await recordSystemEvent(
        opportunity,
        `Approvals needed — ${tier === "below" ? `below ${VARIATION_ESCALATION_PERCENT}%` : `${VARIATION_ESCALATION_PERCENT}% or more`}: ${missing.map(roleName).join(" and ")}. Send each an approval request from the Approvals tab`,
        actor
    );
    await notify({
        event: "procurement.variation.approvals_needed",
        title: `${opportunity.number}: price variation of ${signedPct(pct)} — approval${missing.length === 1 ? "" : "s"} to request`,
        body: `${customerLabel(opportunity)} — suppliers quoted ${money(quotedTotal(row))} against ${money(proposalTotal(row))} in the accepted proposal. Send the ${missing.map((role) => roleName(role).toLowerCase()).join(" and the ")} an approval request from the Approvals tab; the purchase orders are held until it is approved.`,
        roleCode: OPERATIONS_COORDINATOR_ROLE,
        userIds: [opportunity.operationalCoordinatorId],
        opportunity,
        actor,
        includeActor: true,
    });
};

/**
 * A daily nudge while a variation is still unapproved — the chart's "frequent
 * high-priority notifications": to the person asked when an approval request
 * is waiting on them, and to the coordinator when one still has to be sent (or
 * sent again, after a rejection).
 */
export const remindPendingApprovals = async () => {
    const rows = await ProcurementJob.findAll({ include: [{ model: Opportunity, as: "opportunity", attributes: ["id", "number", "businessUnitId", "stage", "lifecycle", "customerLegalName", "customerTradingName", "operationalCoordinatorId"] }] });
    const today = new Date().toISOString().slice(0, 10);
    let raised = 0;
    for (const row of rows) {
        const opportunity = row.opportunity;
        if (!opportunity || opportunity.stage !== PROCUREMENT_STAGE || opportunity.lifecycle !== "Active") continue;
        const pct = signedPct(variationPct(row));
        for (const role of pendingApprovers(row)) {
            const entry = approvalFor(row, role);
            const who = roleName(role).toLowerCase();
            if (entry?.status === "pending" && entry.requestId && entry.approverId) {
                const days = Math.max(1, Math.round((Date.now() - new Date(entry.requestedAt).getTime()) / 86400000));
                const { created } = await notify({
                    event: "procurement.variation.reminder",
                    title: `${opportunity.number}: price variation approval outstanding for ${days} day${days === 1 ? "" : "s"}`,
                    body: `${customerLabel(opportunity)} — the purchase orders are held until you, as the ${who}, approve the variation of ${pct} on ${requestCode({ id: entry.requestId })}.`,
                    userIds: [entry.approverId],
                    opportunity,
                    requestId: entry.requestId,
                    dedupeKey: `procurement-approval:${opportunity.id}:${role}:${today}`,
                });
                raised += created;
            } else {
                const { created } = await notify({
                    event: "procurement.variation.approvals_needed",
                    title: `${opportunity.number}: the ${who}'s approval of the price variation is still to request`,
                    body:
                        entry?.status === "rejected"
                            ? `${customerLabel(opportunity)} — the ${who} did not approve the variation of ${pct}${entry.note ? ` (${entry.note})` : ""}. Revise the quotes or send the request again from the Approvals tab; the purchase orders are held until it is approved.`
                            : `${customerLabel(opportunity)} — the variation of ${pct} needs the ${who}'s approval. Send the request from the Approvals tab; the purchase orders are held until it is approved.`,
                    roleCode: OPERATIONS_COORDINATOR_ROLE,
                    userIds: [opportunity.operationalCoordinatorId],
                    opportunity,
                    dedupeKey: `procurement-approval-request:${opportunity.id}:${role}:${today}`,
                });
                raised += created;
            }
        }
    }
    return raised;
};

// ---- The approval requests (raised and answered through modules/collaboration) ----

/**
 * Whether the coordinator may send `role` an approval request on this job —
 * throws when not: the job has to be at the stage with every line priced, the
 * variation has to need that role, the role must not have approved already or
 * have a request still waiting, and the person asked must hold the role.
 * Returns the job's record for linkVariationApprovalRequest once the request
 * row exists.
 */
export const assertVariationApprovalRequestable = async (opportunity, role, assignee, actor) => {
    const code = String(role ?? "").toUpperCase();
    if (!APPROVER_ROLES[code]) throw httpError(400, "An approval request goes to the sales manager (sales) or the business owner (admin)");
    if (!(await userHasPermission(actor, "procurement.update"))) throw httpError(403, "Only someone working the procurement stage (procurement.update) can request a price-variation approval");
    if (opportunity.stage < PROCUREMENT_STAGE) throw httpError(400, "This job has not reached procurement & delivery yet");
    const row = await ensureJob(opportunity, actor);
    if (!quotesReceived(row)) throw httpError(400, "The variation is measured once every BOQ line is priced — nothing to approve yet");
    if (!requiredApprovers(row).includes(code)) throw httpError(400, `This variation does not need the ${roleName(code).toLowerCase()}'s approval`);
    const entry = approvalFor(row, code);
    if (entry?.status === "approved") throw httpError(400, `The ${roleName(code).toLowerCase()} has already approved this variation`);
    if (entry?.status === "pending" && entry.requestId) throw httpError(400, `An approval request to the ${roleName(code).toLowerCase()} is already waiting (${requestCode({ id: entry.requestId })})`);
    if (!assignee) throw httpError(400, "Choose who the approval request goes to (assigneeId)");
    if (!(Array.isArray(assignee.roles) && assignee.roles.includes(code))) throw httpError(400, `${assignee.name} does not hold the ${roleName(code).toLowerCase()} role`);
    return row;
};

/** The request is saved: the job's approval for that role now waits on it, and the person asked is told. */
export const linkVariationApprovalRequest = async (opportunity, row, role, request, assignee, actor) => {
    const code = String(role).toUpperCase();
    const now = new Date().toISOString();
    const entry = { role: code, approverId: assignee.id, approver: assignee.name, status: "pending", requestedAt: now, decidedAt: null, note: null, requestId: request.id };
    const approvals = approvalFor(row, code) ? approvalsOf(row).map((candidate) => (candidate.role === code ? entry : candidate)) : [...approvalsOf(row), entry];
    await row.update({ approvals });
    const pct = variationPct(row);
    await recordSystemEvent(opportunity, `Approval requested — ${roleName(code).toLowerCase()} ${assignee.name} asked to approve the price variation of ${signedPct(pct)} (${requestCode(request)})`, actor);
    await notify({
        event: "procurement.variation.approval_requested",
        title: `${opportunity.number}: price variation of ${signedPct(pct)} needs your approval`,
        body: `${customerLabel(opportunity)} — suppliers quoted ${money(quotedTotal(row))} against ${money(proposalTotal(row))} in the accepted proposal. ${actor?.name ?? "The coordinator"} asks you, as the ${roleName(code).toLowerCase()}, to approve or reject it on ${requestCode(request)}; the purchase orders are held until it is approved.`,
        userIds: [assignee.id],
        opportunity,
        request,
        actor,
    });
};

/** The request was handed to someone else: the job's approval names them now. */
export const relinkVariationApprovalRequest = async (opportunityId, role, request, assignee, actor) => {
    const found = await findRow(opportunityId);
    if (!found) return;
    const { opportunity, row } = found;
    const code = String(role).toUpperCase();
    const entry = approvalFor(row, code);
    if (!entry || Number(entry.requestId) !== Number(request.id) || entry.status !== "pending") return;
    await row.update({ approvals: approvalsOf(row).map((candidate) => (candidate.role === code ? { ...candidate, approverId: assignee.id, approver: assignee.name } : candidate)) });
    await recordSystemEvent(opportunity, `Approval request ${requestCode(request)} passed to ${assignee.name} (${roleName(code).toLowerCase()})`, actor);
};

/** The request was cancelled while waiting: the approval is back to not requested. */
export const unlinkVariationApprovalRequest = async (opportunityId, role, request, actor) => {
    const found = await findRow(opportunityId);
    if (!found) return;
    const { opportunity, row } = found;
    const code = String(role).toUpperCase();
    const entry = approvalFor(row, code);
    if (!entry || Number(entry.requestId) !== Number(request.id) || entry.status !== "pending") return;
    await row.update({ approvals: approvalsOf(row).map((candidate) => (candidate.role === code ? { ...candidate, approverId: null, approver: null, requestId: null } : candidate)) });
    await recordSystemEvent(opportunity, `Approval request ${requestCode(request)} to the ${roleName(code).toLowerCase()} cancelled — the variation still needs their approval`, actor);
};

/**
 * The approver's answer on their request (collaborationService.decideApproval):
 * recorded on the job's approval and in the history, and told to procurement
 * and the coordinator — and the salesperson when it is a rejection. The last
 * approval in releases the purchase orders.
 */
export const recordVariationDecision = async (opportunityId, role, { outcome, note = null, request = null } = {}, actor) => {
    const code = String(role ?? "").toUpperCase();
    if (!APPROVER_ROLES[code]) throw httpError(400, `role must be one of: ${Object.keys(APPROVER_ROLES).join(", ")}`);
    if (!["approved", "rejected"].includes(outcome)) throw httpError(400, "outcome must be approved or rejected");
    const { opportunity, row } = await loadJob(opportunityId, actor);
    const now = new Date().toISOString();
    const existing = approvalFor(row, code);
    const entry = { role: code, approverId: actor.id, approver: actor.name, status: outcome, requestedAt: existing?.requestedAt ?? now, decidedAt: now, note: note || null, requestId: request?.id ?? existing?.requestId ?? null };
    const approvals = existing ? approvalsOf(row).map((candidate) => (candidate.role === code ? entry : candidate)) : [...approvalsOf(row), entry];
    await row.update({ approvals });

    const pct = signedPct(variationPct(row));
    const approved = outcome === "approved";
    const code2 = request ? ` (${requestCode(request)})` : "";
    await recordSystemEvent(opportunity, `${roleName(code)} ${approved ? "approved" : "did not approve"} the price variation of ${pct}${code2}${note ? ` — ${note}` : ""}`, actor);
    await notify({
        event: "procurement.variation.decided",
        title: `${opportunity.number}: variation ${approved ? "approved" : "not approved"} by the ${roleName(code).toLowerCase()}`,
        body: `${customerLabel(opportunity)} — ${actor.name} ${approved ? "approved" : "declined"} the price variation of ${pct}${note ? `: ${note}` : "."}`,
        roleCode: PROCUREMENT_ROLE,
        userIds: [opportunity.operationalCoordinatorId, request?.createdById, ...(approved ? [] : [opportunity.salespersonId])].filter(Boolean),
        opportunity,
        request,
        actor,
        priority: approved ? undefined : "high",
    });
    if (approved && approvalsComplete(row)) {
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
 * PUT /:id/procurement/boq — the coordinator's two passes over the BOQ: on the
 * BOQ-vs-site tab the quantity the site needs and whether we already hold the
 * item (inInventory); on the supplier-quote tab the supplier chosen, its
 * availability and lead time, and the price on its quote. body:
 *   { lines: [{ key, siteQty?, inInventory?, quotedUnitCost?, supplier?, availability?, leadTimeDays? }],
 *     add?: [{ item, brand?, unit?, kind?, siteQty, inInventory?, quotedUnitCost?, supplier?, availability?, leadTimeDays? }],
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
        if (change.inInventory !== undefined) line.inInventory = asFlag(change.inInventory, "inInventory");
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
                    inInventory: false,
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

/** PO-26-0112: the year where the job's unit is, then a running number across every unit. */
const nextPurchaseOrderNumber = async (opportunity) => {
    const [count, unit] = await Promise.all([PurchaseOrder.count(), BusinessUnit.findByPk(opportunity.businessUnitId, { attributes: ["id", "timezone"] })]);
    return `PO-${unitYear2(unit)}-${String(count + 1).padStart(4, "0")}`;
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
        ref: await nextPurchaseOrderNumber(opportunity),
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
 *   status?, sentAt?, scheduledFor?, deliveredAt?, receivedBy?, reviewed? }
 * Sending needs the variation cleared and no review flag; scheduling needs a
 * date; receiving stamps who and when. { reviewed: true } clears the flag a
 * reopening of the approvals put on it.
 */
export const updatePurchaseOrder = async (id, poId, payload = {}, actor) => {
    const { opportunity, row } = await loadJob(id, actor);
    const po = await loadPurchaseOrder(opportunity, poId);
    const fields = {};
    const events = [];
    if (payload.reviewed === true && po.reviewFlag) {
        fields.reviewFlag = null;
        events.push(`Purchase order reviewed after the approvals were reopened — ${po.ref}`);
    }
    const flagged = po.reviewFlag && fields.reviewFlag !== null;
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

    if (payload.status !== undefined && payload.status !== po.status) {
        const status = payload.status;
        if (!PURCHASE_ORDER_STATUSES.includes(status)) throw httpError(400, `status must be one of: ${PURCHASE_ORDER_STATUSES.join(", ")}`);
        if (status === "draft") throw httpError(400, "An order that has gone to the supplier cannot go back to draft");
        if (po.status === "draft" && flagged)
            throw httpError(409, `${po.ref} is flagged for review since the approvals were reopened — check it still matches them and mark it reviewed first`);
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
 * What the checklists settle, applied to the record: releasing on CL-13 sends
 * the drafted orders, everything arriving on CL-14 receives them, and CL-10
 * complete is the Green Deal job. Each goes in the history; the ones other
 * teams wait on notify. The variation approval is not among them — only the
 * approvers decide that, on their approval requests (recordVariationDecision).
 */
const applyChecklistEffects = async (opportunity, row, section, before, after, actor) => {
    const turnedOn = (key) => after[key] === true && before[key] !== true;
    const name = actor?.name ?? "Operations";

    if (section === "po" && turnedOn("poReleasedConfirmed")) {
        const all = await PurchaseOrder.findAll({ where: { opportunityId: opportunity.id, status: "draft" } });
        // A draft flagged when the approvals were reopened stays held until it is marked reviewed.
        const drafts = all.filter((po) => !po.reviewFlag);
        const held = all.filter((po) => po.reviewFlag);
        const sentAt = parseDate(after.poReleasedOn, "poReleasedOn") ?? new Date();
        for (const po of drafts) await po.update({ status: "sent", sentAt });
        await recordSystemEvent(
            opportunity,
            `${drafts.length ? `Purchase orders sent — ${drafts.map((po) => po.ref).join(", ")} (released on CL-13)` : "PO released to supplier — recorded on CL-13"}${held.length ? ` — held for review: ${held.map((po) => po.ref).join(", ")}` : ""}`,
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
    // The variation approval cannot be ticked: each approver decides it on their own approval request.
    if (section === "po" && Object.keys(clean).some((key) => ["variationApproved", "variationApprovedBy"].includes(key)))
        throw httpError(400, "The variation approval is taken from the approval requests on the Approvals tab — it cannot be ticked on CL-13");

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
    if (!approvalsComplete(row)) waiting.push("the price-variation approval (PO release)");
    if (!SECTION_DONE.receipt(answersOf(row, "receipt"))) waiting.push("the material receipt");
    return waiting.length ? `Job creation opens once the price-variation approval and material receipt are complete — still waiting on ${waiting.join(" and ")}` : null;
};

// ---- The stage gates ----------------------------------------------------------------------
// Procurement ends at the purchase order release (CL-13). The material receipt
// (CL-14) and the Green Deal job (CL-10) are worked while the job is in
// construction, on the same record, and let it leave construction — mirrors
// prestige-fe helpers/stageTransition.js procurementGateItems.

/** Why the job cannot leave procurement, or null: every item on PO release (CL-13) done. */
export const procurementBlocker = async (opportunity) => {
    const row = await ProcurementJob.findOne({ where: { opportunityId: opportunity.id } });
    if (!row) return "Work the procurement checklists before leaving procurement & delivery";
    if (!sectionComplete(row, "po")) return "Complete every item on PO release (CL-13) before leaving procurement";
    return null;
};

/** Why the job cannot leave construction, or null: the materials confirmed ready (CL-14) and the Green Deal job created (CL-10). */
export const constructionBlocker = async (opportunity) => {
    const row = await ProcurementJob.findOne({ where: { opportunityId: opportunity.id } });
    if (!row) return "Receive the materials and create the job in Green Deal before leaving construction";
    if (answersOf(row, "receipt").materialsReady !== true) return "Confirm the materials are ready for installation (material receipt, CL-14) before leaving construction";
    if (!SECTION_DONE.jobCreation(answersOf(row, "jobCreation"))) return "Create the job in Green Deal and confirm it matches the signed quote (CL-10) before leaving construction";
    return null;
};
