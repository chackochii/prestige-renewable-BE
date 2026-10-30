// Approvals (stage 5): the DA, DNSP, finance and other approvals a job has
// to clear before procurement can start — only the ones this job needs.
//
//   which ones — decided early and kept on the record as requiredApprovals:
//                sales ticks them on the lead form, estimation confirms or
//                changes them (PUT /:id/required-approvals), and the
//                coordinator can still add one at stage 5. Keys come from the
//                unit's approvalTypes catalogue (Admin → Unit settings).
//   the rows   — one `approvals` row per required type, created when the job
//                enters the stage (enterApprovals, from moveToNextStage). The
//                dnsp / da / finance rows carry the Operations Coordinator's
//                checklist answers (worked on the screen); the rest are
//                recorded directly: status, who it is with, the reference,
//                dates, a note, and the finer outcome, evidence and
//                conditions on their answers.
//   the way out — UAT exit logic (Oct 2026, prestige-fe PR #18): nothing
//                moves the job on by itself. When every approval that applies
//                is complete the coordinator and owners are told it is ready;
//                someone allowed to then sends it (Send to Procurement —
//                POST /:id/advance, sendToProcurement), reviewing any
//                conditions first, and procurement is told. A job can be put
//                On Hold, a rejected approval is resolved one of five ways
//                (resolveRejection), the approvals are read-only once sent
//                (documents and notes can still be added — addenda) and can
//                be reopened from procurement or construction, which flags
//                the purchase orders already raised. A job coming back after
//                a redesign resets the approvals the change touches, and any
//                still lodged against the old quote raise Approval Review
//                Needed until someone marks them reviewed.

import { Op } from "sequelize";
import db from "../../../models/index.js";
import { parseId } from "../../../utils/ids.js";
import { multiLine, oneLine } from "../../../utils/text.js";
import { notify } from "../../notification/service/notificationService.js";
import { SUPER_ROLE_CODE, userHasPermission } from "../../role/service/roleService.js";
import { BUSINESS_OWNER_ROLE, OPERATIONS_COORDINATOR_ROLE, SALES_MANAGER_ROLE, recordSystemEvent } from "./leadWorkflowService.js";
import { assignedUserIds, customerLabel } from "./opportunityPeople.js";
import { getOpportunity, moveToNextStage, searchCondition } from "./opportunityService.js";
import { advancePermissionFor, readableStages, STAGE_LABELS } from "./stageAccess.js";
import { APPROVAL_STATUSES } from "../model/approval.js";
import { serviceRequirementKeys } from "../model/opportunity.js";
import { LIVE_STATUSES } from "../model/proposal.js";
import { newestFirst, pageOf, pagingOf } from "../../../utils/pagination.js";

const { Opportunity, Approval, BusinessUnit, User, Proposal, QuoteVersion, OpportunityHistory, Notification, PurchaseOrder, RequoteRequest, Document } = db;

const httpError = (status, message) => Object.assign(new Error(message), { status });

export const APPROVALS_STAGE = 5;
const ESTIMATION_STAGE = 2;
const PROPOSAL_STAGE = 3;
/** Approvals are reopened from procurement & delivery or construction (prestige-fe ReopenApprovals). */
const REOPENABLE_STAGES = [6, 7];
/** Types the coordinator works through a checklist on the approvals screen (prestige-fe constants/approvalChecklists.js). */
export const CHECKLIST_TYPES = ["dnsp", "da", "finance"];
const FINANCE_ROLE = "FIN";
const PROCUREMENT_ROLE = "PROC";

/** What the standard approvals are called, whatever a unit's settings still say (prestige-fe helpers/requiredApprovals.js). */
export const APPROVAL_LABELS = {
    dnsp: "Network Connection Approval (DNSP)",
    da: "Council Approval (DA)",
    finance: "Finance Approval",
    strata: "Strata Approval",
    heritage: "Heritage Approval",
    landlord: "Landlord Consent",
    rebate: "Rebate Pre-Approval",
};

/** Not an approval any more — every job needs it, and it is handled at installation & handover. */
export const HANDOVER_ONLY_TYPES = ["electrical_safety"];

/** Which approvals restart when a redesign changes this (prestige-fe constants/approvals.js APPROVAL_RESETS). */
export const APPROVAL_RESETS = { system: ["dnsp", "rebate"], total: ["finance"], layout: ["da", "heritage", "strata"] };

/** What can be done about a rejected approval (UAT RJ-01..05). */
export const REJECTION_OPTIONS = ["resubmit", "return_estimation", "return_sales", "change_approach", "close_lost"];
export const LOST_REASONS = { approval_refused: "Approval Refused", customer_withdrew: "Customer Withdrew", other: "Other" };

/** The finance checklist's statuses that mean the application went to the lender. */
const FINANCE_LODGED_STATUSES = ["submitted", "info_requested", "approved", "approved_conditions"];
/** Failed after it was given: blocks the exit like a rejection, and flags a review once the job has moved on. */
const LAPSED = ["revoked", "expired"];

/** Answers the server keeps on an approval — never taken from a request. */
const SERVER_ANSWERS = ["addenda", "previousSubmissions", "submissionNumber", "lodgedQuote", "closed", "replaces"];
/**
 * The answers a status records (the checklists' status records and the plain
 * approval form's) — set aside when an approval is resubmitted or reset, so it
 * starts again from Not Started with the earlier submission kept in History.
 */
const STATUS_ANSWERS = [
    "status", "outcome", "reference", "submittedOn", "infoRequested", "decidedOn", "expiresOn", "connectionDocs", "conditions",
    "limitDiffers", "approvedExportKw", "rejectionReason", "declineReason", "lapseReason", "naReason", "withdrawnReason",
    "exemptionDetails", "evidence", "approvedAmount", "shortfallNote", "notifiedOn", "submittedQuoteTotal",
];

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isBlank = (value) => value === undefined || value === null || String(value).trim() === "";

// ---- The catalogue and the job's list ------------------------------------------

/** The approvals a unit's jobs can need: [{ key, label }], in the unit's order. */
export const catalogueFor = (unit) =>
    (Array.isArray(unit?.approvalTypes) ? unit.approvalTypes : [])
        .filter((type) => type && typeof type.key === "string" && type.key.trim())
        .map((type) => ({ key: type.key.trim(), label: oneLine(type.label, 120) || type.key.trim() }));

const labelFor = (catalogue, key) => APPROVAL_LABELS[key] ?? catalogue.find((type) => type.key === key)?.label ?? key;

const currentKeys = (opportunity) => (Array.isArray(opportunity.requiredApprovals) ? opportunity.requiredApprovals : []);

/** The approvals added to this job only (opportunity.customApprovalTypes): [{ key, label }]. */
const customTypesOf = (opportunity) =>
    (Array.isArray(opportunity?.customApprovalTypes) ? opportunity.customApprovalTypes : []).filter(
        (type) => type && typeof type.key === "string" && type.key.trim()
    );

/**
 * The approvals one job can need: the unit's catalogue, then the custom ones
 * added to the job — mirrors prestige-fe helpers/requiredApprovals.js
 * jobApprovalUnit. A custom key the unit has since added keeps the unit's label.
 */
export const jobCatalogueFor = (unit, opportunity) => {
    const listed = catalogueFor(unit);
    const custom = customTypesOf(opportunity)
        .map((type) => ({ key: type.key.trim(), label: oneLine(type.label, 120) || type.key.trim() }))
        .filter((type) => !listed.some((candidate) => candidate.key === type.key));
    return [...listed, ...custom];
};

/** An array of approval keys as the API accepts it — trimmed, deduplicated, capped. */
export const sanitizeRequiredApprovals = (list) => {
    if (!Array.isArray(list)) throw httpError(400, "requiredApprovals must be an array of approval keys");
    if (list.length > 20) throw httpError(400, "requiredApprovals: at most 20 entries");
    return [...new Set(list.map((key) => oneLine(key, 20)).filter(Boolean))];
};

/**
 * Keys must come from the unit's catalogue, or from the custom approvals
 * already added to `opportunity` — a unit with no approvals section accepts
 * none of its own.
 */
export const assertApprovalKeys = (keys, unit, opportunity = null) => {
    const known = new Set(jobCatalogueFor(unit, opportunity).map((type) => type.key));
    const unknown = keys.filter((key) => !known.has(key));
    if (unknown.length)
        throw httpError(400, `Unknown approval type${unknown.length > 1 ? "s" : ""} for this business unit: ${unknown.join(", ")}`);
    return keys;
};

/** [{ label }] — the custom approvals a request names, trimmed and deduplicated by name. */
const sanitizeCustomApprovals = (list) => {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list)) throw httpError(400, "custom must be a list of { label }");
    if (list.length > 10) throw httpError(400, "custom: at most 10 approvals at a time");
    const labels = list.map((entry) => oneLine(typeof entry === "string" ? entry : entry?.label, 120)).filter(Boolean);
    if (labels.length !== list.length) throw httpError(400, "custom: every approval needs a name (label)");
    return [...new Map(labels.map((label) => [label.toLowerCase(), label])).values()];
};

/**
 * The key each named approval goes under. A name the job's list already has
 * (the unit's or an earlier custom one, matched without case) is that
 * approval, so the same thing is never added twice; anything new becomes a
 * custom type on the job, keyed custom_1, custom_2, … in the order added.
 */
const keysForCustom = (labels, catalogue, customTypes) => {
    const types = [...customTypes];
    const keys = labels.map((label) => {
        const known = catalogue.find((type) => type.label.toLowerCase() === label.toLowerCase());
        if (known) return known.key;
        const taken = new Set([...catalogue, ...types].map((type) => type.key));
        let n = types.length + 1;
        while (taken.has(`custom_${n}`)) n += 1;
        const type = { key: `custom_${n}`, label };
        types.push(type);
        catalogue = [...catalogue, type];
        return type.key;
    });
    return { keys, types };
};

const loadOpportunity = async (id) => {
    const opportunity = await Opportunity.findByPk(parseId(id, "opportunity id"));
    if (!opportunity) throw httpError(404, "Opportunity not found");
    return opportunity;
};

const rowsFor = (opportunityIds) =>
    Approval.findAll({
        where: { opportunityId: { [Op.in]: opportunityIds } },
        include: [{ model: User, as: "owner", attributes: ["id", "name"] }],
        order: [["id", "ASC"]],
    });

/**
 * The job's approval rows brought into line with its list: a row for every
 * required type (created, or re-required), and rows for types taken off the
 * list marked not required — kept, so what was lodged is not lost.
 */
const syncRows = async (opportunity, catalogue) => {
    const keys = currentKeys(opportunity);
    const rows = await Approval.findAll({ where: { opportunityId: opportunity.id } });
    for (const key of keys) {
        const row = rows.find((candidate) => candidate.type === key);
        if (!row) await Approval.create({ opportunityId: opportunity.id, type: key, label: labelFor(catalogue, key), required: true });
        else if (!row.required) await row.update({ required: true, label: labelFor(catalogue, key) });
    }
    for (const row of rows) if (!keys.includes(row.type) && row.required) await row.update({ required: false });
};

/**
 * { keys: [...], custom?: [{ label }] } → the opportunity. Who may: sales
 * (leads.update), estimation (estimation.update) or the coordinator
 * (approvals.update) — the route decides; this validates against the job's
 * catalogue, records the change, and keeps the stage-5 rows in step when the
 * job is already there. `custom` names approvals the unit's list lacks: each
 * is added to this job only (customApprovalTypes) and ticked with `keys`.
 * Once the job has been sent to procurement the list is read-only.
 */
export const setRequiredApprovals = async (id, payload = {}, actor) => {
    const opportunity = await loadOpportunity(id);
    if (opportunity.stage > APPROVALS_STAGE && opportunity.approvalSent)
        throw httpError(409, "The job has been sent to Procurement — reopen its approvals to change which ones it needs");
    const unit = await BusinessUnit.findByPk(opportunity.businessUnitId);
    const requested = assertApprovalKeys(sanitizeRequiredApprovals(payload.keys ?? payload.requiredApprovals ?? []), unit, opportunity);

    const labels = sanitizeCustomApprovals(payload.custom);
    const { keys: customKeys, types } = keysForCustom(labels, jobCatalogueFor(unit, opportunity), customTypesOf(opportunity));
    const keys = [...new Set([...requested, ...customKeys])];
    if (keys.length > 20) throw httpError(400, "requiredApprovals: at most 20 entries");
    const typesAdded = types.length > customTypesOf(opportunity).length;
    if (typesAdded) await opportunity.update({ customApprovalTypes: types });
    const catalogue = jobCatalogueFor(unit, opportunity);

    const before = currentKeys(opportunity);
    const changed = keys.length !== before.length || keys.some((key) => !before.includes(key));
    if (changed) {
        await opportunity.update({ requiredApprovals: keys });
        await recordSystemEvent(
            opportunity,
            keys.length ? `Approvals required: ${keys.map((key) => labelFor(catalogue, key)).join(", ")}` : "Approvals required: none",
            actor
        );
        if (opportunity.stage >= APPROVALS_STAGE) await syncRows(opportunity, catalogue);
    }
    return getOpportunity(opportunity.id);
};

// ---- Reading the rows ----------------------------------------------------------------

const answersOf = (row) => (isPlainObject(row?.checklist) ? row.checklist : {});

/** The finer status the answers hold — a recorded approval's outcome, or a checklist's status — else the row's. */
const finerStatusOf = (row) => answersOf(row).outcome ?? answersOf(row).status ?? row.status;

/** How the portal names an approval: the standard name, else the one it was added under. */
const labelOfRow = (row) => {
    const key = answersOf(row).closed?.originalKey ?? row.type;
    return APPROVAL_LABELS[key] ?? row.label ?? key;
};

/** Why an approval was rejected, as recorded (prestige-fe helpers/approvals.js rejectionReasonOf). */
const rejectionReasonOf = (row) => {
    const answers = answersOf(row);
    return answers.rejectionReason || answers.declineReason || answers.lapseReason || (row.status === "rejected" ? row.notes : null) || null;
};

/**
 * The approvals that count on this job (prestige-fe helpers/approvals.js
 * approvalItems): the required rows, less the handover-only ones, finance
 * while the customer is not paying by finance, and heritage once the DA
 * checklist says the property is not listed.
 */
export const countedRows = (opportunity, rows) => {
    const required = rows.filter((row) => row.required);
    const da = required.find((row) => row.type === "da");
    return required
        .filter((row) => !HANDOVER_ONLY_TYPES.includes(row.type))
        .filter((row) => !(row.type === "finance" && opportunity.financeAssistance === "no"))
        .filter((row) => !(row.type === "heritage" && answersOf(da).heritage === "not_listed"));
};

/** complete (approved, with conditions, exempt, not applicable) | failed (rejected, declined, revoked, expired) | open. */
const groupOf = (row) => (["approved", "not_applicable"].includes(row.status) ? "complete" : row.status === "rejected" ? "failed" : "open");

/**
 * Where a job stands, as the board's badge and its filters read it (prestige-fe
 * helpers/approvals.js approvalStatus): review | sent | returned | rejected |
 * on_hold | in_progress | ready.
 */
export const jobStatusOf = (opportunity, rows) => {
    const counted = countedRows(opportunity, rows);
    const failed = counted.some((row) => groupOf(row) === "failed");
    if (opportunity.stage > APPROVALS_STAGE) return opportunity.approvalReview || failed ? "review" : "sent";
    if (opportunity.stage < APPROVALS_STAGE && opportunity.approvalReturn) return "returned";
    if (failed) return "rejected";
    if (opportunity.approvalHold) return "on_hold";
    return counted.every((row) => groupOf(row) === "complete") ? "ready" : "in_progress";
};

/** The approvals given with conditions: [{ key, label, conditions }] (prestige-fe approvalConditions). */
const conditionsOf = (opportunity, rows) =>
    countedRows(opportunity, rows)
        .filter((row) => row.status === "approved" && finerStatusOf(row) === "approved_conditions" && !isBlank(answersOf(row).conditions))
        .map((row) => ({ key: row.type, label: labelOfRow(row), conditions: String(answersOf(row).conditions) }));

/** The finance application went in against one quote total and the quote has changed since. */
const financeNeedsReview = (row, acceptedValue) => {
    const answers = answersOf(row);
    if (!FINANCE_LODGED_STATUSES.includes(answers.status)) return false;
    if (isBlank(answers.submittedQuoteTotal) || acceptedValue === null) return false;
    return Math.abs(Number(acceptedValue) - Number(answers.submittedQuoteTotal)) > 0.005;
};

/**
 * Why the job cannot be sent to Procurement yet, one line each; empty when it
 * can (prestige-fe helpers/approvalChecklist.js sendBlockers): not On Hold, no
 * review outstanding, every approval that counts complete, evidence on the
 * recorded ones approved, and finance not lodged against an old quote total.
 */
const sendBlockersFor = (opportunity, rows, acceptedValue) => {
    if (opportunity.approvalHold) return [`On Hold: ${opportunity.approvalHold.reason || "resume the job first"}`];
    if (opportunity.approvalReview)
        return ["Approval Review Needed: the quote was revised after approvals were lodged - review them and mark them reviewed"];
    const counted = countedRows(opportunity, rows);
    const waiting = counted.filter((row) => groupOf(row) !== "complete");
    if (waiting.length) return [`Waiting on: ${waiting.map(labelOfRow).join(", ")}`];
    const unproven = counted.filter(
        (row) => row.status === "approved" && !CHECKLIST_TYPES.includes(row.type) && !(Array.isArray(answersOf(row).evidence) && answersOf(row).evidence.length)
    );
    const finance = counted.find((row) => row.type === "finance" && financeNeedsReview(row, acceptedValue));
    return [
        ...(unproven.length ? [`Attach the approval evidence: ${unproven.map(labelOfRow).join(", ")}`] : []),
        ...(finance ? [`${labelOfRow(finance)}: the quote has changed since it was lodged - review it`] : []),
    ];
};

// ---- The accepted quote ---------------------------------------------------------------

const PHASES = { "1_phase": "Single phase", "3_phase": "Three phase" };

const num = (value) => (value === null || value === undefined || value === "" ? null : Number(value));

/** The system as the approvals forms describe it, read off the accepted quote's items. */
const systemFromItems = (items) => {
    const list = Array.isArray(items) ? items : [];
    const of = (...keys) => list.filter((item) => keys.includes(item.itemKey));
    const name = (item) => item.brand || item.itemName || "";
    const panels = of("solar_panel");
    const panelQty = panels.reduce((sum, item) => sum + (num(item.quantity) || 0), 0);
    // "Jinko Tiger Neo 440W" → 440; the size is panels × watts.
    const watts = panels.reduce((sum, item) => sum + (num(item.quantity) || 0) * (Number((String(name(item)).match(/(\d{3,4})\s*W\b/i) || [])[1]) || 0), 0);
    const inverters = of("string_inverter", "hybrid_inverter");
    const batteries = of("battery");
    const other = of("ev_charger");
    return {
        sizeKw: watts ? Number((watts / 1000).toFixed(2)) : null,
        panels: panels.length ? panels.map((item) => `${num(item.quantity) || ""} × ${name(item)}`.trim()).join(", ") : null,
        inverter: inverters.length ? inverters.map(name).join(", ") : null,
        hybrid: of("hybrid_inverter").length > 0,
        battery: batteries.length ? batteries.map((item) => `${name(item)}${num(item.quantity) ? ` ${num(item.quantity)} ${item.unit || "kWh"}` : ""}`).join(", ") : null,
        otherEquipment: other.length ? other.map((item) => `${num(item.quantity) > 1 ? `${num(item.quantity)} × ` : ""}${name(item)}`).join(", ") : null,
        panelQty: panelQty || null,
    };
};

/** Quote lines before costs: quantity × price, less the line discount (prestige-fe helpers/quote.js lineTotal). */
const itemsTotalOf = (items) =>
    (Array.isArray(items) ? items : []).reduce((sum, item) => sum + (num(item.quantity) || 0) * (num(item.unitPrice) || 0) * (1 - (num(item.discountPct) || 0) / 100), 0);

/** The rebates on the accepted quote, [{ type, amount }] — what a Rebate Pre-Approval is checked against. */
const quoteRebatesOf = (quote) => {
    const itemsTotal = itemsTotalOf(quote?.items);
    return (Array.isArray(quote?.additionalCosts) ? quote.additionalCosts : [])
        .filter((cost) => cost?.kind === "rebate")
        .map((cost) => {
            const value = num(cost.value) || 0;
            const amount = cost.calcType === "percentage" ? itemsTotal * (value / 100) : value;
            return { type: cost.costType || "Rebate", amount: Math.round(amount * 100) / 100 };
        });
};

/** The total the approvals work from: the accepted version's, else the job's accepted value. */
const acceptedValueOf = (opportunity, accepted) => num(accepted?.grandTotal) ?? num(opportunity.acceptedValue) ?? null;

/** The quote an approval was lodged against (NF-12): enough to tell later whether a revision touched it. */
const quoteStampOf = (opportunity, accepted) => {
    const version = accepted?.quoteVersion;
    if (!version) return null;
    const system = systemFromItems(version.snapshot?.quote?.items);
    return {
        id: version.id,
        version: version.version,
        quoteNumber: version.quoteNumber ?? null,
        total: acceptedValueOf(opportunity, accepted),
        system: { sizeKw: system.sizeKw, inverter: system.inverter, battery: system.battery },
        at: new Date().toISOString(),
    };
};

/** What a revised quote changed against the one an approval was lodged on: a set of APPROVAL_RESETS keys. */
const changesBetween = (was, now) => {
    const changes = new Set();
    if (!was || !now) return changes;
    const system = (stamp) => JSON.stringify([stamp.system?.sizeKw ?? null, stamp.system?.inverter ?? null, stamp.system?.battery ?? null]);
    if (was.system && system(was) !== system(now)) changes.add("system");
    if (was.total !== null && was.total !== undefined && now.total !== null && Math.abs(Number(was.total) - Number(now.total)) > 0.005) changes.add("total");
    return changes;
};

// ---- Entering the stage ----------------------------------------------------------

const resetRow = async (row, actor, extra = {}) => {
    const answers = answersOf(row);
    const previous = Array.isArray(answers.previousSubmissions) ? answers.previousSubmissions : [];
    const recorded = Object.fromEntries(STATUS_ANSWERS.filter((key) => answers[key] !== undefined).map((key) => [key, answers[key]]));
    const entry = {
        status: finerStatusOf(row),
        authority: row.authority ?? null,
        reference: row.reference ?? null,
        submittedAt: row.submittedAt ?? null,
        decidedAt: row.outcomeAt ?? null,
        reason: rejectionReasonOf(row),
        note: row.notes ?? null,
        lodgedQuote: answers.lodgedQuote ?? null,
        answers: recorded,
        closedAt: new Date().toISOString(),
        by: actor?.name ?? null,
        ...extra,
    };
    const kept = Object.fromEntries(Object.entries(answers).filter(([key]) => !STATUS_ANSWERS.includes(key) && key !== "lodgedQuote"));
    const previousSubmissions = [...previous, entry];
    await row.update({
        status: "not_started",
        reference: null,
        submittedAt: null,
        outcomeAt: null,
        notes: null,
        checklist: { ...kept, previousSubmissions, submissionNumber: previousSubmissions.length + 1 },
    });
};

/** Nothing lodged on it yet: no status past Not Started, and no quote stamped. */
const neverLodged = (row) => row.status === "not_started" && !answersOf(row).lodgedQuote;

/**
 * A job coming back to approvals (after Return to Estimation or Sales, or any
 * later acceptance): the approvals the redesign touches restart — the ones
 * picked when it was returned, and any whose trigger shows up in the revised
 * quote (the system for DNSP and rebate, the total for finance) — and the
 * ones kept but lodged against an older quote raise Approval Review Needed.
 */
const settleReturn = async (opportunity, actor) => {
    const back = opportunity.approvalReturn;
    const rows = (await Approval.findAll({ where: { opportunityId: opportunity.id, required: true } })).filter((row) => !neverLodged(row));
    if (!back && !rows.length) return { resets: [], review: [] };
    const accepted = (await acceptedProposalsFor([opportunity.id])).get(opportunity.id) ?? null;
    const now = quoteStampOf(opportunity, accepted);
    const chosen = new Set(Array.isArray(back?.resetKeys) ? back.resetKeys : []);
    const resets = [];
    const review = [];
    for (const row of rows) {
        const was = answersOf(row).lodgedQuote ?? null;
        const revised = Boolean(back) || Boolean(was && now && was.id !== now.id);
        if (!revised || row.status === "not_applicable") continue;
        const triggered = [...changesBetween(was, now)].some((change) => APPROVAL_RESETS[change].includes(row.type));
        if (chosen.has(row.type) || triggered) {
            await resetRow(row, actor, { resolution: "reset", resolutionReason: chosen.has(row.type) ? "Redesign after Return to Estimation" : "The revised quote changed what it was lodged on" });
            resets.push(labelOfRow(row));
        } else review.push(`${labelOfRow(row)}: lodged against ${was ? `${was.quoteNumber ? `${was.quoteNumber} ` : ""}v${was.version}` : "the earlier quote"}`);
    }
    const version = accepted?.quoteVersion;
    await opportunity.update({
        approvalReturn: null,
        approvalHold: null,
        approvalReview: review.length
            ? {
                  at: new Date().toISOString(),
                  reason: `The quote was revised${version ? ` (now ${version.quoteNumber ? `${version.quoteNumber} ` : ""}v${version.version})` : ""} after approvals were lodged`,
                  lines: review,
              }
            : opportunity.approvalReview,
    });
    if (resets.length) await recordSystemEvent(opportunity, `Back at Approvals — reset to Not Started: ${resets.join(", ")}`, actor);
    if (review.length) await recordSystemEvent(opportunity, `Approval Review Needed — ${review.join("; ")}`.slice(0, 5000), actor);
    return { resets, review };
};

/**
 * The job has just moved to approvals (called by moveToNextStage): create the
 * rows for what it needs and tell the operations coordinators what there is
 * to lodge — and finance, when the customer is financing the job. A job
 * coming back from a redesign has its approvals settled first (settleReturn).
 */
export const enterApprovals = async (opportunity, actor = null) => {
    const unit = await BusinessUnit.findByPk(opportunity.businessUnitId);
    const catalogue = jobCatalogueFor(unit, opportunity);
    await syncRows(opportunity, catalogue);
    const { resets, review } = await settleReturn(opportunity, actor);
    const keys = currentKeys(opportunity).filter((key) => !HANDOVER_ONLY_TYPES.includes(key));
    const labels = keys.map((key) => labelFor(catalogue, key));
    const settled = [resets.length ? `reset to Not Started: ${resets.join(", ")}` : null, review.length ? "the approvals lodged against the earlier quote need reviewing" : null]
        .filter(Boolean)
        .join("; ");

    await notify({
        event: "approvals.started",
        title: `${opportunity.number}: approvals to lodge`,
        body: labels.length
            ? `${customerLabel(opportunity)} — ${labels.join(", ")}.${settled ? ` Back after a revision: ${settled}.` : ""} Work through each on the approvals page.`
            : `${customerLabel(opportunity)} — no approvals were marked as required. Confirm none are needed, or add them on the approvals page.`,
        roleCode: OPERATIONS_COORDINATOR_ROLE,
        userIds: [opportunity.operationalCoordinatorId],
        opportunity,
        actor,
        includeActor: true,
    });
    if (keys.includes("finance") && opportunity.financeAssistance !== "no" && !review.length)
        await notify({
            event: "approvals.finance_required",
            title: `${opportunity.number}: finance application to initiate`,
            body: `${customerLabel(opportunity)} is financing the job${opportunity.financeNotes ? ` — ${opportunity.financeNotes}` : ""}. Start the finance application from the approvals page.`,
            roleCode: FINANCE_ROLE,
            opportunity,
            actor,
            includeActor: true,
        });
};

// ---- Presenting ------------------------------------------------------------------

const existingSystemOf = (opportunity) => {
    const input = opportunity.estimationInput || {};
    const retrofit = input.isRetrofit === true || input.isRetrofit === "yes" || input.isRetrofit === "true";
    if (!retrofit) return "None";
    return (
        [input.existingSolarKw ? `${input.existingSolarKw} kW solar` : null, input.existingInverter, input.existingBattery, input.existingSystemNotes]
            .filter(Boolean)
            .join(" · ") || "Existing system — details not recorded"
    );
};

/** "14 Wharf Rd, Birchgrove NSW 2041" — shared with procurement's presenter. */
export const siteOf = (opportunity) =>
    [opportunity.siteLine1, [opportunity.siteSuburb, opportunity.siteState, opportunity.sitePostcode].filter(Boolean).join(" ")].filter(Boolean).join(", ") || null;

/** What the job is for, from the lead's service requirements ("both" read as solar and battery). */
const servicesOf = (opportunity) => [...new Set(serviceRequirementKeys(opportunity.serviceRequirement).flatMap((key) => (key === "both" ? ["solar", "battery"] : [key])))];

const presentItem = (row) => ({
    key: row.type,
    type: row.type,
    label: labelOfRow(row),
    required: row.required,
    applicable: row.required,
    hasChecklist: CHECKLIST_TYPES.includes(row.type),
    status: row.status,
    authority: row.authority,
    reference: row.reference,
    owner: row.owner?.name ?? null,
    ownerId: row.ownerId,
    submittedAt: row.submittedAt,
    decidedAt: row.outcomeAt,
    note: row.notes,
    documentName: row.documentName,
    checklist: answersOf(row),
    updatedAt: row.updatedAt,
});

/** "Estimator assigned — Jane" → { action, detail }; the approvals history tab shows both lines. */
const presentHistory = (row) => {
    const [action, ...rest] = String(row.note ?? "").split(" — ");
    return { at: row.createdAt, by: row.author?.name ?? "System", action, detail: rest.join(" — ") || null };
};

const presentNotice = (row) => ({ at: row.createdAt, rule: row.event, to: row.user?.name ?? "—", priority: row.priority, message: row.body || row.title });

/** { reason, by, at } — the people-facing part of a stamp; the user id stays on the record. */
const stampOf = (value) => (isPlainObject(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "byId")) : null);

/**
 * One job as the approvals screens read it: the facts the checklists auto-fill
 * (customer, site, contact, phase, existing system, the accepted quote's
 * system, rebates and total), its required approvals in catalogue order, where
 * it stands on the way out (on hold, sent, reopened, review, returned), its
 * history and the notifications this stage raised. The board and the detail
 * view return the same shape, so the approvals page loads once and opens any
 * of its jobs without asking again. `catalogue` is the unit's: the job's own
 * custom approvals are added to it here.
 */
const presentJob = (opportunity, { catalogue: unitCatalogue, rows, accepted, salesperson = null, history = null, notifications = null }) => {
    const catalogue = jobCatalogueFor({ approvalTypes: unitCatalogue }, opportunity);
    const order = new Map(catalogue.map((type, index) => [type.key, index]));
    const own = rows.filter((row) => row.opportunityId === opportunity.id);
    const items = own
        .filter((row) => row.required)
        .sort((a, b) => (order.get(a.type) ?? 99) - (order.get(b.type) ?? 99) || a.id - b.id)
        .map(presentItem);
    const snapshot = accepted?.quoteVersion?.snapshot;
    const commercial = opportunity.leadType === "commercial";
    return {
        id: opportunity.id,
        number: opportunity.number,
        stage: opportunity.stage,
        lifecycle: opportunity.lifecycle,
        customer: customerLabel(opportunity),
        site: siteOf(opportunity),
        council: null, // not captured on the lead — the coordinator confirms it on the DA checklist
        contact: {
            name: opportunity.contactName || [opportunity.customerFirstName, opportunity.customerLastName].filter(Boolean).join(" ") || customerLabel(opportunity),
            email: opportunity.contactEmail || opportunity.customerEmail || null,
            phone: opportunity.contactPhone || opportunity.customerPhone || null,
        },
        leadType: opportunity.leadType ?? null,
        // A commercial customer's business, for the finance application.
        business: commercial ? { name: opportunity.customerTradingName || opportunity.customerLegalName || null, abn: opportunity.customerAbn || null } : null,
        services: servicesOf(opportunity),
        phase: PHASES[opportunity.electricalPhase] ?? null,
        existingSystem: existingSystemOf(opportunity),
        system: systemFromItems(snapshot?.quote?.items),
        quoteRebates: quoteRebatesOf(snapshot?.quote),
        quoteDate: snapshot?.quote?.quoteDate ?? null,
        acceptedValue: acceptedValueOf(opportunity, accepted),
        acceptedProposal: accepted ? { id: accepted.id, number: accepted.number, quoteVersion: accepted.quoteVersion ? { id: accepted.quoteVersion.id, version: accepted.quoteVersion.version, quoteNumber: accepted.quoteVersion.quoteNumber } : null } : null,
        financeAssistance: opportunity.financeAssistance ?? null,
        financeNotes: opportunity.financeNotes ?? null,
        salesperson: salesperson ? { id: salesperson.id, name: salesperson.name } : null,
        operationalCoordinatorId: opportunity.operationalCoordinatorId,
        enteredAt: opportunity.stage === APPROVALS_STAGE ? opportunity.slaStartedAt : null,
        slaDueAt: opportunity.stage === APPROVALS_STAGE ? opportunity.slaDueAt : null,
        lastActivityAt: opportunity.updatedAt,
        requiredApprovals: currentKeys(opportunity),
        catalogue,
        // The way out and back (UAT exit logic): each null when it does not apply.
        approvalStatus: jobStatusOf(opportunity, own),
        onHold: stampOf(opportunity.approvalHold),
        sentToProcurement: opportunity.stage > APPROVALS_STAGE ? stampOf(opportunity.approvalSent) : null,
        approvalsReopened: stampOf(opportunity.approvalReopened),
        approvalReview: opportunity.approvalReview ?? null,
        approvalReturn: stampOf(opportunity.approvalReturn),
        lostReason: opportunity.lostReason ?? null,
        items,
        // Closed after a change of approach: kept for the history, no longer counted.
        closedItems: own.filter((row) => !row.required && answersOf(row).closed).map(presentItem),
        ...(history ? { history } : {}),
        ...(notifications ? { notifications } : {}),
    };
};

/** The accepted proposal of each job, with the quote version it was for — shared with procurement. */
export const acceptedProposalsFor = async (opportunityIds) => {
    const rows = await Proposal.findAll({
        where: { opportunityId: { [Op.in]: opportunityIds }, status: "accepted" },
        include: [{ model: QuoteVersion, as: "quoteVersion", attributes: ["id", "version", "quoteNumber", "grandTotal", "snapshot"] }],
        order: [["version", "DESC"]],
    });
    const byOpp = new Map();
    for (const row of rows) if (!byOpp.has(row.opportunityId)) byOpp.set(row.opportunityId, row);
    return byOpp;
};

/**
 * The installed equipment in one line — "8.8 kW · 20 × Jinko Tiger Neo 440W ·
 * Sungrow SH5.0RS · Sungrow SBR HV 9.6 kWh" — as the accepted quote had it.
 * Shown on the record from construction on (warranty registration, DLP).
 */
export const installedSystemSummary = async (opportunityId) => {
    const accepted = (await acceptedProposalsFor([opportunityId])).get(opportunityId);
    if (!accepted) return null;
    const system = systemFromItems(accepted.quoteVersion?.snapshot?.quote?.items);
    return [system.sizeKw ? `${system.sizeKw} kW` : null, system.panels, system.inverter, system.battery].filter(Boolean).join(" · ") || null;
};

/** How much of a job's history, and how many of its notices, a job carries. */
const PER_JOB_LIMIT = 100;

/**
 * The history and the approvals notices of several jobs in two queries,
 * newest first and capped per job — the board shows a full job for each row,
 * so the approvals page needs one request, not one per job it opens.
 */
const historyAndNoticesFor = async (opportunityIds) => {
    const [history, notices] = await Promise.all([
        OpportunityHistory.findAll({
            where: { opportunityId: { [Op.in]: opportunityIds } },
            include: [{ model: User, as: "author", attributes: ["id", "name"] }],
            order: [["createdAt", "DESC"], ["id", "DESC"]],
            limit: PER_JOB_LIMIT * opportunityIds.length,
        }),
        Notification.findAll({
            where: { opportunityId: { [Op.in]: opportunityIds }, event: { [Op.like]: "approvals.%" } },
            include: [{ model: User, as: "user", attributes: ["id", "name"] }],
            order: [["createdAt", "DESC"], ["id", "DESC"]],
            limit: PER_JOB_LIMIT * opportunityIds.length,
        }),
    ]);
    const perJob = (list, present) => {
        const byOpp = new Map();
        for (const row of list) {
            const held = byOpp.get(row.opportunityId) ?? [];
            if (held.length < PER_JOB_LIMIT) held.push(present(row));
            byOpp.set(row.opportunityId, held);
        }
        return byOpp;
    };
    return { history: perJob(history, presentHistory), notifications: perJob(notices, presentNotice) };
};

/** The job's approvals, with everything the detail view shows. */
export const listApprovals = async (id) => {
    const opportunity = await loadOpportunity(id);
    const [unit, rows, accepted, salesperson, { history, notifications }] = await Promise.all([
        BusinessUnit.findByPk(opportunity.businessUnitId),
        rowsFor([opportunity.id]),
        acceptedProposalsFor([opportunity.id]),
        opportunity.salespersonId ? User.findByPk(opportunity.salespersonId, { attributes: ["id", "name"] }) : null,
        historyAndNoticesFor([opportunity.id]),
    ]);
    return presentJob(opportunity, {
        catalogue: catalogueFor(unit),
        rows,
        accepted: accepted.get(opportunity.id) ?? null,
        salesperson,
        history: history.get(opportunity.id) ?? [],
        notifications: notifications.get(opportunity.id) ?? [],
    });
};

/** The board's card filters (prestige-fe ApprovalsPage CARDS), plus the other badges. */
export const BOARD_FILTERS = ["in_progress", "ready", "rejected", "overdue", "on_hold", "returned", "review", "sent"];

/**
 * Jobs with an approval whose name matches the search — the unit's label on
 * the row, or the standard name the portal shows for it.
 */
const approvalSearchIds = async (search, opportunityIds) => {
    if (!search || !String(search).trim() || !opportunityIds.length) return [];
    const typed = String(search).trim();
    const term = `%${typed.replace(/[\\%_]/g, "\\$&")}%`;
    const named = Object.entries(APPROVAL_LABELS)
        .filter(([, label]) => label.toLowerCase().includes(typed.toLowerCase()))
        .map(([key]) => key);
    const rows = await Approval.findAll({
        where: {
            opportunityId: { [Op.in]: opportunityIds },
            required: true,
            [Op.or]: [{ label: { [Op.iLike]: term } }, ...(named.length ? [{ type: { [Op.in]: named } }] : [])],
        },
        attributes: ["opportunityId"],
    });
    return [...new Set(rows.map((row) => row.opportunityId))];
};

/**
 * The approvals page, a page at a time: every active job at the stage, jobs
 * sent back from it to estimation or sales (until they return), plus jobs that
 * moved on in the last 30 days (so "sent to procurement" does not vanish the
 * moment it is), narrowed to the stages the person may read — newest first,
 * the job that reached approvals most recently at the top. `search` matches
 * the job, the customer or an approval's name; `filter` narrows to one of
 * BOARD_FILTERS. `counts` carries the stat cards across the whole board, not
 * the filter (prestige-fe ApprovalsPage): pending (in progress), ready,
 * rejected, overdue (at the stage past its SLA), and the other badges. Each
 * row is the whole job as the detail view reads it, history and notices
 * included, so opening one asks for nothing more.
 */
export const approvalsBoard = async (query = {}, actor) => {
    const { businessUnitId, search, filter } = query;
    if (filter && !BOARD_FILTERS.includes(String(filter))) throw httpError(400, `filter must be one of: ${BOARD_FILTERS.join(", ")}`);
    const paging = pagingOf(query);
    const unitId = parseId(businessUnitId, "business unit id");
    const allowed = await readableStages(actor);
    const since = new Date(Date.now() - 30 * 86400000);
    const found = await Opportunity.findAll({
        where: {
            businessUnitId: unitId,
            lifecycle: "Active",
            stage: { [Op.in]: allowed.length ? allowed : [0] },
            [Op.or]: [
                { stage: APPROVALS_STAGE },
                { stage: { [Op.gt]: APPROVALS_STAGE }, slaStartedAt: { [Op.gte]: since } },
                { stage: { [Op.lt]: APPROVALS_STAGE }, approvalReturn: { [Op.ne]: null } },
            ],
        },
        limit: 1000,
    });
    const counts = { all: 0, pending: 0, ready: 0, rejected: 0, overdue: 0, on_hold: 0, returned: 0, review: 0, sent: 0, approved: 0 };
    const empty = { rows: [], total: 0, page: paging.page, pageSize: paging.pageSize, counts };
    if (!found.length) return empty;

    // The search box: the job, the customer or the suburb, or an approval's name.
    let opportunities = found;
    if (search && String(search).trim()) {
        const [matched, byApproval] = await Promise.all([
            Opportunity.findAll({ where: { id: { [Op.in]: found.map((o) => o.id) }, ...searchCondition(search) }, attributes: ["id"] }),
            approvalSearchIds(search, found.map((o) => o.id)),
        ]);
        const ids = new Set([...matched.map((o) => o.id), ...byApproval]);
        opportunities = found.filter((opportunity) => ids.has(opportunity.id));
        if (!opportunities.length) return empty;
    }

    const allRows = await rowsFor(opportunities.map((opportunity) => opportunity.id));
    const rowsOf = new Map();
    for (const row of allRows) rowsOf.set(row.opportunityId, [...(rowsOf.get(row.opportunityId) ?? []), row]);
    const now = new Date();
    const jobs = opportunities
        // A job away from the stage only belongs here if it went through it.
        .filter((opportunity) => opportunity.stage === APPROVALS_STAGE || rowsOf.has(opportunity.id))
        // Newest first: the job that reached the stage most recently at the top.
        .sort(newestFirst((opportunity) => opportunity.slaStartedAt ?? opportunity.createdAt));
    const statusOf = new Map();
    for (const opportunity of jobs) {
        const status = jobStatusOf(opportunity, rowsOf.get(opportunity.id) ?? []);
        const overdue = opportunity.stage === APPROVALS_STAGE && opportunity.slaDueAt && new Date(opportunity.slaDueAt) < now;
        statusOf.set(opportunity.id, { status, overdue });
        counts.all += 1;
        counts[status === "in_progress" ? "pending" : status] += 1;
        if (status === "ready" || status === "sent") counts.approved += 1;
        if (overdue) counts.overdue += 1;
    }
    const shown = filter
        ? jobs.filter((opportunity) => (filter === "overdue" ? statusOf.get(opportunity.id).overdue : statusOf.get(opportunity.id).status === filter))
        : jobs;

    const onPage = pageOf(shown, paging);
    if (!onPage.length) return { ...empty, total: shown.length };
    const ids = onPage.map((opportunity) => opportunity.id);
    const [unit, accepted, people, { history, notifications }] = await Promise.all([
        BusinessUnit.findByPk(unitId),
        acceptedProposalsFor(ids),
        User.findAll({ where: { id: { [Op.in]: [...new Set(onPage.map((o) => o.salespersonId).filter(Boolean))] } }, attributes: ["id", "name"] }),
        historyAndNoticesFor(ids),
    ]);
    const catalogue = catalogueFor(unit);
    const names = new Map(people.map((user) => [user.id, user]));
    const rows = onPage.map((opportunity) =>
        presentJob(opportunity, {
            catalogue,
            rows: rowsOf.get(opportunity.id) ?? [],
            accepted: accepted.get(opportunity.id) ?? null,
            salesperson: names.get(opportunity.salespersonId) ?? null,
            history: history.get(opportunity.id) ?? [],
            notifications: notifications.get(opportunity.id) ?? [],
        })
    );
    return { rows, total: shown.length, page: paging.page, pageSize: paging.pageSize, counts };
};

// ---- Recording an approval ---------------------------------------------------------

const parseDate = (value, field) => {
    if (value === null || value === undefined || value === "") return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw httpError(400, `${field} must be a date`);
    return date;
};

/** Approvals activity is activity on the job: the home page's no-activity list reads updatedAt. */
const touch = async (opportunity) => {
    opportunity.changed("updatedAt", true);
    await opportunity.save();
};

const assertNotClosed = (opportunity) => {
    if (["Lost", "Closed"].includes(opportunity.lifecycle)) throw httpError(409, `The job is ${opportunity.lifecycle.toLowerCase()} — its approvals are closed`);
};

/** One approval on the job, by type — it must be one the job needs. */
const requiredRow = async (opportunity, type) => {
    const row = await Approval.findOne({ where: { opportunityId: opportunity.id, type: oneLine(type, 20) } });
    if (!row || !row.required) throw httpError(404, "This approval is not on the job — add it to the required approvals first");
    return row;
};

/** "approved with conditions", "revoked" — how the history and notices name a status. */
const STATUS_WORDS = {
    not_started: "reset to not started",
    submitted: "lodged",
    lodged: "lodged",
    info_requested: "further information requested",
    approved: "approved",
    approved_conditions: "approved with conditions",
    exempt: "marked exempt",
    rejected: "not given",
    refused: "refused",
    declined: "declined",
    withdrawn: "withdrawn",
    revoked: "revoked",
    expired: "expired",
    not_applicable: "marked not applicable",
};

/** What a status change means for the people on the job, and the record. */
const afterStatusChange = async (opportunity, row, actor) => {
    const finer = finerStatusOf(row);
    const verb = STATUS_WORDS[finer] ?? STATUS_WORDS[row.status] ?? row.status;
    const label = labelOfRow(row);
    const where = [row.authority, row.reference].filter(Boolean).join(" ");
    const why = row.status === "rejected" ? rejectionReasonOf(row) : null;
    await recordSystemEvent(opportunity, `${label} ${verb}${where ? ` — ${where}` : ""}${why ? ` — ${why}` : ""}`.slice(0, 5000), actor);

    if (row.status === "rejected" && opportunity.stage > APPROVALS_STAGE) {
        // Failed after the job moved on: procurement and the coordinators review it.
        const title = `${opportunity.number}: ${label} ${verb} — approval review needed`;
        const body = `${customerLabel(opportunity)} — ${label} was ${verb}${why ? `: ${why}` : ""} after the job was sent to procurement. Review the job; reopen its approvals if they need to change.`;
        await notify({ event: "approvals.review_needed", title, body, roleCode: PROCUREMENT_ROLE, userIds: assignedUserIds(opportunity), opportunity, actor });
        await notify({ event: "approvals.review_needed", title, body, roleCode: OPERATIONS_COORDINATOR_ROLE, opportunity, actor });
        await notify({ event: "approvals.review_needed", title, body, roleCode: BUSINESS_OWNER_ROLE, opportunity, actor });
        return;
    }
    if (row.status === "rejected") {
        // The chart: back to the salesperson; the sales manager and owner told.
        const body = `${customerLabel(opportunity)} — ${label} was ${verb}${why ? `: ${why}` : ""}. Resolve it on the approvals page, or relook at the options with the customer.`;
        await notify({ event: "approvals.rejected", title: `${opportunity.number}: ${label} ${verb}`, body, roleCode: SALES_MANAGER_ROLE, userIds: [opportunity.salespersonId], opportunity, actor });
        await notify({ event: "approvals.rejected", title: `${opportunity.number}: ${label} ${verb}`, body, roleCode: BUSINESS_OWNER_ROLE, opportunity, actor });
        return;
    }

    // The last one complete: ready to send — someone sends it (Send to Procurement); nothing moves by itself.
    if (["approved", "not_applicable"].includes(row.status) && opportunity.stage === APPROVALS_STAGE && opportunity.lifecycle === "Active") {
        const rows = await Approval.findAll({ where: { opportunityId: opportunity.id } });
        const counted = countedRows(opportunity, rows);
        if (!counted.length || counted.some((candidate) => groupOf(candidate) !== "complete")) return;
        await recordSystemEvent(opportunity, "All approvals complete — ready to send to Procurement", actor);
        const title = `${opportunity.number}: approvals complete — ready to send to procurement`;
        const body = `${customerLabel(opportunity)} — every approval is complete${opportunity.approvalHold ? " (the job is On Hold — resume it first)" : ""}. Send the job to Procurement from the approvals page.`;
        await notify({ event: "approvals.complete", title, body, roleCode: OPERATIONS_COORDINATOR_ROLE, userIds: [opportunity.operationalCoordinatorId], opportunity, actor, includeActor: true });
        await notify({ event: "approvals.complete", title, body, roleCode: BUSINESS_OWNER_ROLE, opportunity, actor });
    }
};

/**
 * PATCH /:id/approvals/:type — { status?, authority?, reference?, submittedAt?,
 * decidedAt?, note?, documentName?, checklist? } → the job's approvals.
 * `checklist` is merged into what is held (the screen sends the answers that
 * changed; the server's own — addenda, earlier submissions, the quote it was
 * lodged against — are never taken from it). Lodging and deciding stamp the
 * dates and who did it when not given, and the first lodgement stamps the
 * accepted quote. Once the job is sent to procurement the status can only
 * become revoked or expired; anything else needs the approvals reopened.
 */
export const updateApproval = async (id, type, payload = {}, actor) => {
    const opportunity = await loadOpportunity(id);
    assertNotClosed(opportunity);
    if (opportunity.stage < APPROVALS_STAGE)
        throw httpError(409, `The job is back at ${STAGE_LABELS[opportunity.stage] ?? `stage ${opportunity.stage}`} — its approvals are worked again when it returns to Approvals`);
    const row = await requiredRow(opportunity, type);

    const update = {};
    if (payload.status !== undefined) {
        if (!APPROVAL_STATUSES.includes(payload.status)) throw httpError(400, `status must be one of ${APPROVAL_STATUSES.join(", ")}`);
        update.status = payload.status;
    }
    if (payload.authority !== undefined) update.authority = oneLine(payload.authority, 255) || null;
    if (payload.reference !== undefined) update.reference = oneLine(payload.reference, 120) || null;
    if (payload.submittedAt !== undefined) update.submittedAt = parseDate(payload.submittedAt, "submittedAt");
    if (payload.decidedAt !== undefined) update.outcomeAt = parseDate(payload.decidedAt, "decidedAt");
    if (payload.note !== undefined) update.notes = multiLine(payload.note, 2000) || null;
    if (payload.documentName !== undefined) update.documentName = oneLine(payload.documentName, 255) || null;
    if (payload.checklist !== undefined) {
        if (!isPlainObject(payload.checklist)) throw httpError(400, "checklist must be an object of answers");
        const given = Object.fromEntries(Object.entries(payload.checklist).filter(([key]) => !SERVER_ANSWERS.includes(key)));
        const merged = { ...answersOf(row), ...given };
        if (JSON.stringify(merged).length > 200000) throw httpError(400, "checklist is too large");
        update.checklist = merged;
    }

    const was = row.status;
    let changing = update.status !== undefined && update.status !== was;
    // Sent: read-only, except recording that a given approval has since lapsed.
    if (changing && opportunity.stage > APPROVALS_STAGE) {
        const answers = update.checklist ?? answersOf(row);
        if (!LAPSED.includes(answers.outcome ?? answers.status))
            throw httpError(409, "The job has been sent to Procurement — its approvals are read-only. Record it as revoked or expired, or reopen the approvals to change it.");
        // A checklist saves as it is typed: until the lapse's records are in it
        // reports an interim status, and the approval stays as it was.
        if (update.status !== "rejected") {
            for (const field of ["status", "submittedAt", "outcomeAt"]) delete update[field];
            changing = false;
        }
    }
    if (changing) {
        if (update.status === "submitted" && update.submittedAt === undefined && !row.submittedAt) update.submittedAt = new Date();
        if (["approved", "rejected"].includes(update.status) && update.outcomeAt === undefined && !row.outcomeAt) update.outcomeAt = new Date();
        if (!row.ownerId && actor?.id) update.ownerId = actor.id;
        // The quote it was lodged against (NF-12) — what tells a later revision whether it still holds.
        const answers = update.checklist ?? answersOf(row);
        if (was === "not_started" && ["submitted", "approved", "rejected"].includes(update.status) && !answers.lodgedQuote) {
            const stamp = quoteStampOf(opportunity, (await acceptedProposalsFor([opportunity.id])).get(opportunity.id));
            if (stamp) update.checklist = { ...answers, lodgedQuote: stamp };
        }
    }
    await row.update(update);
    await touch(opportunity);
    if (changing) await afterStatusChange(opportunity, row, actor);
    return listApprovals(opportunity.id);
};

// ---- The way out, and back ---------------------------------------------------------

/**
 * Who may send a job to Procurement (sendRoles) or reopen its approvals
 * (reopenRoles): the roles picked on Unit settings (metadata.approvalAccess),
 * or — with none picked — the permission. ADM always may (prestige-fe
 * helpers/approvals.js approvalAccess).
 */
const mayUse = async (actor, unit, key, permission) => {
    const roles = Array.isArray(actor?.roles) ? actor.roles : [];
    if (roles.includes(SUPER_ROLE_CODE)) return true;
    const picked = unit?.metadata?.approvalAccess?.[key];
    if (Array.isArray(picked) && picked.length) return roles.some((code) => picked.includes(code));
    return userHasPermission(actor, permission);
};

const stamp = (actor, extra = {}) => ({ at: new Date().toISOString(), by: actor?.name ?? null, byId: actor?.id ?? null, ...extra });

/**
 * Send to Procurement — POST /:id/advance on a job at approvals ({
 * conditionsReviewed }). The person must be allowed to (the unit's send roles,
 * else approvals.update), the job ready (sendBlockersFor) and any conditions
 * the approvals came with reviewed. The job moves on, the send is recorded
 * (the approvals are read-only from here) and procurement is told to start.
 */
export const sendToProcurement = async (opportunity, actor, { conditionsReviewed = false } = {}) => {
    const unit = await BusinessUnit.findByPk(opportunity.businessUnitId);
    if (!(await mayUse(actor, unit, "sendRoles", advancePermissionFor(APPROVALS_STAGE))))
        throw httpError(403, "Sending a job to Procurement needs one of the roles picked on Unit settings (Approvals access), or approvals.update");
    const [rows, accepted] = await Promise.all([Approval.findAll({ where: { opportunityId: opportunity.id } }), acceptedProposalsFor([opportunity.id])]);
    const blockers = sendBlockersFor(opportunity, rows, acceptedValueOf(opportunity, accepted.get(opportunity.id)));
    if (blockers.length) throw httpError(400, blockers.join(" · "));
    const conditions = conditionsOf(opportunity, rows);
    if (conditions.length && conditionsReviewed !== true)
        throw httpError(400, `Review the conditions on ${conditions.map((entry) => entry.label).join(", ")} before sending the job to Procurement (conditionsReviewed)`);

    const listed = conditions.map((entry) => `${entry.label}: ${entry.conditions}`).join("; ");
    const title = `${opportunity.number}: sent to procurement — create the job and start`;
    const body = `${customerLabel(opportunity)} — every approval is complete; sent by ${actor?.name ?? "operations"}.${listed ? ` Approval conditions to work to: ${listed}.` : ""} Create the job and start procurement.`;
    await moveToNextStage(opportunity, actor, { event: "approvals.complete", title, body });
    await opportunity.update({ approvalSent: stamp(actor, { conditionsReviewed: conditions.length > 0 }), approvalReopened: null });
    await recordSystemEvent(opportunity, `Sent to Procurement${listed ? ` — approval conditions reviewed: ${listed}` : ""}`.slice(0, 5000), actor);
    await notify({ event: "approvals.complete", title, body: body.slice(0, 2000), roleCode: PROCUREMENT_ROLE, opportunity, actor, includeActor: true });
    return getOpportunity(opportunity.id);
};

/** The job, at approvals and still active — the On Hold and rejection actions work only there. */
const loadAtApprovals = async (id, doing) => {
    const opportunity = await loadOpportunity(id);
    if (opportunity.lifecycle !== "Active") throw httpError(400, `Only active jobs can be ${doing}`);
    if (opportunity.stage !== APPROVALS_STAGE) throw httpError(409, `The job is not at Approvals — only a job there can be ${doing}`);
    return opportunity;
};

/** POST /:id/approvals/hold — { reason } → the job's approvals, On Hold: it cannot be sent until resumed. */
export const holdApprovals = async (id, payload = {}, actor) => {
    const opportunity = await loadAtApprovals(id, "put on hold");
    const reason = multiLine(payload.reason, 2000);
    if (!reason) throw httpError(400, "Say why the job is on hold (reason)");
    if (opportunity.approvalHold) throw httpError(409, "The job is already on hold");
    await opportunity.update({ approvalHold: stamp(actor, { reason }) });
    await recordSystemEvent(opportunity, `Approvals put On Hold — ${reason}`, actor);
    return listApprovals(opportunity.id);
};

/** POST /:id/approvals/resume → the job's approvals, off hold. */
export const resumeApprovals = async (id, actor) => {
    const opportunity = await loadAtApprovals(id, "resumed");
    const held = opportunity.approvalHold;
    if (!held) throw httpError(409, "The job is not on hold");
    await opportunity.update({ approvalHold: null });
    await recordSystemEvent(opportunity, `Approvals resumed — was on hold: ${held.reason}`.slice(0, 5000), actor);
    return listApprovals(opportunity.id);
};

/** POST /:id/approvals/review — { note? } → the job's approvals, Approval Review Needed cleared. */
export const markApprovalsReviewed = async (id, payload = {}, actor) => {
    const opportunity = await loadOpportunity(id);
    assertNotClosed(opportunity);
    if (!opportunity.approvalReview) throw httpError(409, "No approval review is waiting on this job");
    const note = multiLine(payload.note, 2000);
    await opportunity.update({ approvalReview: null });
    await recordSystemEvent(opportunity, `Approvals reviewed against the revised quote${note ? ` — ${note}` : ""}`, actor);
    return listApprovals(opportunity.id);
};

/**
 * POST /:id/approvals/reopen — { reason } → the job's approvals, back at
 * stage 5. For a job in procurement or construction; the unit's reopen roles
 * decide who may (else approvals.approve). Procurement and the coordinators
 * are told, and every purchase order already raised is flagged for review —
 * held until someone marks it reviewed. It goes on again with Send to Procurement.
 */
export const reopenApprovals = async (id, payload = {}, actor) => {
    const opportunity = await loadOpportunity(id);
    const reason = multiLine(payload.reason, 2000);
    if (!reason) throw httpError(400, "Say why the approvals need to change (reason)");
    if (opportunity.lifecycle !== "Active") throw httpError(400, "Only active jobs can have their approvals reopened");
    if (!REOPENABLE_STAGES.includes(opportunity.stage))
        throw httpError(409, "Approvals are reopened while the job is in Procurement & delivery or Construction");
    const unit = await BusinessUnit.findByPk(opportunity.businessUnitId);
    if (!(await mayUse(actor, unit, "reopenRoles", "approvals.approve")))
        throw httpError(403, "Reopening approvals needs one of the roles picked on Unit settings (Approvals access), or approvals.approve");

    const fromStage = opportunity.stage;
    const now = new Date();
    const slaDays = Number(unit?.slaDays?.[APPROVALS_STAGE] ?? 0);
    await opportunity.update({
        stage: APPROVALS_STAGE,
        slaStartedAt: now,
        slaDueAt: slaDays ? new Date(now.getTime() + slaDays * 86400000) : null,
        approvalReopened: stamp(actor, { reason, fromStage }),
        approvalSent: null,
    });
    const orders = await PurchaseOrder.findAll({ where: { opportunityId: opportunity.id }, order: [["id", "ASC"]] });
    const flag = { reason: `Approvals reopened${actor?.name ? ` by ${actor.name}` : ""}: ${reason}`.slice(0, 2000), at: now.toISOString(), by: actor?.name ?? null };
    for (const po of orders) await po.update({ reviewFlag: flag });
    await recordSystemEvent(
        opportunity,
        `Approvals reopened from ${STAGE_LABELS[fromStage] ?? `stage ${fromStage}`} — ${reason}${orders.length ? ` — purchase order${orders.length === 1 ? "" : "s"} flagged for review: ${orders.map((po) => po.ref).join(", ")}` : ""}`.slice(0, 5000),
        actor
    );
    const title = `${opportunity.number}: approvals reopened — back at Approvals`;
    const body = `${customerLabel(opportunity)} — ${actor?.name ?? "Someone"} reopened the approvals from ${STAGE_LABELS[fromStage] ?? `stage ${fromStage}`}: ${reason}.${orders.length ? ` ${orders.length} purchase order${orders.length === 1 ? " is" : "s are"} flagged for review.` : ""} The job is sent on again once the approvals are settled.`;
    await notify({ event: "approvals.reopened", title, body, roleCode: PROCUREMENT_ROLE, userIds: assignedUserIds(opportunity), opportunity, actor });
    await notify({ event: "approvals.reopened", title, body, roleCode: OPERATIONS_COORDINATOR_ROLE, opportunity, actor });
    return listApprovals(opportunity.id);
};

/** [{ id, filename, url }] — files already on the job's attachments (useApprovalJob uploads them first). */
const cleanFiles = async (opportunity, list) => {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list)) throw httpError(400, "files must be a list of { id, filename, url }");
    if (list.length > 10) throw httpError(400, "files: at most 10 at a time");
    const ids = list.map((file) => Number(file?.id));
    if (ids.some((fileId) => !Number.isInteger(fileId) || fileId <= 0)) throw httpError(400, "files: each needs the id of a document uploaded to the job");
    const docs = await Document.findAll({ where: { id: { [Op.in]: ids }, opportunityId: opportunity.id }, attributes: ["id"] });
    if (docs.length !== new Set(ids).size) throw httpError(400, "files: every file must be a document on this job");
    return list.map((file) => ({
        id: Number(file.id),
        filename: oneLine(file.filename, 255) || "file",
        url: typeof file.url === "string" ? file.url.slice(0, 1000) : null,
    }));
};

/**
 * POST /:id/approvals/:type/addenda — { note?, files? } → the job's
 * approvals. A document or note on an approval once the job is past it (AP-02):
 * its status untouched, the addition kept on its answers and in the history.
 */
export const addApprovalAddendum = async (id, type, payload = {}, actor) => {
    const opportunity = await loadOpportunity(id);
    assertNotClosed(opportunity);
    if (opportunity.stage < APPROVALS_STAGE) throw httpError(409, "The job has not reached Approvals");
    const row = await requiredRow(opportunity, type);
    const note = multiLine(payload.note, 2000) || null;
    const files = await cleanFiles(opportunity, payload.files);
    if (!note && !files.length) throw httpError(400, "Add a note or a document");
    const addenda = [...(Array.isArray(answersOf(row).addenda) ? answersOf(row).addenda : []), { at: new Date().toISOString(), by: actor?.name ?? null, byId: actor?.id ?? null, note, files }];
    if (addenda.length > 200) throw httpError(400, "This approval has as many additions as it can hold");
    await row.update({ checklist: { ...answersOf(row), addenda } });
    await touch(opportunity);
    const what = files.length ? `document${files.length === 1 ? "" : "s"} added: ${files.map((file) => file.filename).join(", ")}` : "note added";
    await recordSystemEvent(opportunity, `${labelOfRow(row)} — ${what}${note ? ` — ${note}` : ""}`.slice(0, 5000), actor);
    return listApprovals(opportunity.id);
};

/** A type free for the closed approval to be kept under, so a new application of the same kind starts clean. */
const archiveTypeFor = async (opportunity, type) => {
    const taken = new Set((await Approval.findAll({ where: { opportunityId: opportunity.id }, attributes: ["type"] })).map((row) => row.type));
    let n = 1;
    while (taken.has(`${type.slice(0, 16)}~${n}`)) n += 1;
    return `${type.slice(0, 16)}~${n}`;
};

/** Back a stage for a returned job: a fresh SLA clock, off hold, and where it went and why. */
const sendBack = async (opportunity, unit, stage, fields) => {
    const enabled = (Array.isArray(unit?.enabledStages) ? unit.enabledStages : []).map(Number);
    if (enabled.length && !enabled.includes(stage))
        throw httpError(400, `${STAGE_LABELS[stage]} is not enabled for this business unit, so the job cannot go back there`);
    const now = new Date();
    const slaDays = Number(unit?.slaDays?.[stage] ?? 0);
    await opportunity.update({
        stage,
        slaStartedAt: now,
        slaDueAt: slaDays ? new Date(now.getTime() + slaDays * 86400000) : null,
        approvalHold: null,
        ...fields,
    });
};

/**
 * POST /:id/approvals/:type/resolve — what to do about a rejected approval
 * (UAT RJ-01..05), each with a reason → the job's approvals:
 *   resubmit           — back to Not Started; the submission is kept in History
 *   return_estimation  — the job goes back to Estimation as a re-quote round; the
 *                        `changes` (system | total | layout) pick which approvals
 *                        restart when it comes back
 *   return_sales       — the job goes back to Proposal; the accepted proposal is
 *                        open again so the customer decides
 *   change_approach    — the rejected one is closed and `newKey` (or a custom
 *                        `newLabel`) added in its place
 *   close_lost         — the job is closed as lost, with a `lostReason`
 */
export const resolveRejection = async (id, type, payload = {}, actor) => {
    const opportunity = await loadAtApprovals(id, "resolved");
    const row = await requiredRow(opportunity, type);
    const label = labelOfRow(row);
    if (row.status !== "rejected") throw httpError(409, `${label} is not rejected`);
    const option = String(payload.option ?? "");
    if (!REJECTION_OPTIONS.includes(option)) throw httpError(400, `option must be one of: ${REJECTION_OPTIONS.join(", ")}`);
    const reason = multiLine(payload.reason, 2000);
    if (!reason) throw httpError(400, "Give the reason for this resolution (reason)");
    const unit = await BusinessUnit.findByPk(opportunity.businessUnitId);
    const finer = STATUS_WORDS[finerStatusOf(row)] ?? "rejected";
    const resolved = { resolution: option, resolutionReason: reason };

    if (option === "resubmit") {
        await resetRow(row, actor, resolved);
        await recordSystemEvent(opportunity, `${label} to be resubmitted — ${reason}`, actor);
    }

    if (option === "return_estimation") {
        const changes = Array.isArray(payload.changes) ? [...new Set(payload.changes.map(String))] : [];
        const unknown = changes.filter((change) => !Object.hasOwn(APPROVAL_RESETS, change));
        if (unknown.length) throw httpError(400, `changes must be any of: ${Object.keys(APPROVAL_RESETS).join(", ")}`);
        if (!opportunity.estimatorId) throw httpError(400, "Assign an estimator to the job before returning it to Estimation");
        if (await RequoteRequest.count({ where: { opportunityId: opportunity.id, status: "open" } })) throw httpError(409, "A re-quote is already with the estimator");
        const keys = currentKeys(opportunity);
        const resetKeys = [...new Set(changes.flatMap((change) => APPROVAL_RESETS[change]))].filter((key) => keys.includes(key) && key !== row.type);
        const catalogue = jobCatalogueFor(unit, opportunity);
        const accepted = (await acceptedProposalsFor([opportunity.id])).get(opportunity.id) ?? null;
        await resetRow(row, actor, resolved);
        // The estimator's re-quote round: the estimation screen shows it, and the hand-back completes it.
        await Proposal.update({ status: "re-estimated" }, { where: { opportunityId: opportunity.id, status: { [Op.in]: [...LIVE_STATUSES, "accepted"] } } });
        const round = (await RequoteRequest.count({ where: { opportunityId: opportunity.id } })) + 1;
        const comments = `Returned from Approvals — ${label} ${finer}: ${reason}${changes.length ? ` (what will change: ${changes.join(", ")})` : ""}`.slice(0, 2000);
        await RequoteRequest.create({
            opportunityId: opportunity.id,
            round,
            status: "open",
            proposalId: accepted?.id ?? null,
            quoteVersionId: accepted?.quoteVersionId ?? null,
            comments,
            requestedById: actor?.id ?? null,
            estimatorId: opportunity.estimatorId,
        });
        await sendBack(opportunity, unit, ESTIMATION_STAGE, {
            requoteRequestedAt: new Date(),
            approvalReturn: stamp(actor, {
                to: "estimation",
                approval: label,
                approvalKey: row.type,
                reason,
                changes,
                resets: [label, ...resetKeys.map((key) => labelFor(catalogue, key))],
                resetKeys,
            }),
        });
        await recordSystemEvent(opportunity, `Returned to Estimation from Approvals — ${label} ${finer}: ${reason}`.slice(0, 5000), actor);
        const title = `${opportunity.number}: returned to estimation from approvals`;
        const body = `${customerLabel(opportunity)} — ${label} was ${finer}: ${reason}. Revise the quote (re-quote round ${round}); the customer re-accepts it before the job returns to Approvals.`;
        await notify({ event: "approvals.returned", title, body, userIds: [opportunity.estimatorId], opportunity, actor });
        await notify({ event: "approvals.returned", title, body, roleCode: SALES_MANAGER_ROLE, userIds: [opportunity.salespersonId], opportunity, actor });
    }

    if (option === "return_sales") {
        await resetRow(row, actor, resolved);
        // The accepted proposal is open again: the customer decides, then accepts (back to Approvals) or asks for a re-quote.
        await Proposal.update({ status: "negotiation" }, { where: { opportunityId: opportunity.id, status: "accepted" } });
        await sendBack(opportunity, unit, PROPOSAL_STAGE, {
            approvalReturn: stamp(actor, { to: "sales", approval: label, approvalKey: row.type, reason, changes: [], resets: [label], resetKeys: [] }),
        });
        await recordSystemEvent(opportunity, `Returned to Sales from Approvals — ${label} ${finer}: ${reason}`.slice(0, 5000), actor);
        const title = `${opportunity.number}: returned to sales from approvals`;
        const body = `${customerLabel(opportunity)} — ${label} was ${finer}: ${reason}. Talk the options through with the customer; once they accept again the job returns to Approvals.`;
        await notify({ event: "approvals.returned", title, body, roleCode: SALES_MANAGER_ROLE, userIds: [opportunity.salespersonId], opportunity, actor });
    }

    if (option === "change_approach") {
        const newLabel = oneLine(payload.newLabel, 120);
        const newKey = oneLine(payload.newKey, 20);
        if (!newKey && !newLabel) throw httpError(400, "Pick the new approval (newKey) or name it (newLabel)");
        let key = newKey;
        let types = customTypesOf(opportunity);
        if (newLabel) ({ keys: [key], types } = keysForCustom([newLabel], jobCatalogueFor(unit, opportunity), types));
        else assertApprovalKeys([key], unit, opportunity);
        if (key !== row.type && currentKeys(opportunity).includes(key)) throw httpError(409, `${labelFor(jobCatalogueFor(unit, opportunity), key)} is already on the job`);
        if (types.length > customTypesOf(opportunity).length) await opportunity.update({ customApprovalTypes: types });
        const catalogue = jobCatalogueFor(unit, opportunity);
        const replacedBy = labelFor(catalogue, key);
        const original = row.type;
        // Closed and kept under a type of its own, so a new application of the same kind starts clean.
        await row.update({
            type: await archiveTypeFor(opportunity, original),
            required: false,
            checklist: { ...answersOf(row), closed: stamp(actor, { reason, replacedBy, replacedByKey: key, originalKey: original }) },
        });
        const keys = [...currentKeys(opportunity).filter((candidate) => candidate !== original), ...(currentKeys(opportunity).includes(key) && key !== original ? [] : [key])];
        await opportunity.update({ requiredApprovals: keys });
        await syncRows(opportunity, catalogue);
        const added = await Approval.findOne({ where: { opportunityId: opportunity.id, type: key } });
        await added.update({ checklist: { ...answersOf(added), replaces: { key: original, label } } });
        await recordSystemEvent(opportunity, `${label} closed — change of approach to ${replacedBy}: ${reason}`.slice(0, 5000), actor);
    }

    if (option === "close_lost") {
        const lostReason = String(payload.lostReason ?? "");
        if (!Object.hasOwn(LOST_REASONS, lostReason)) throw httpError(400, `lostReason must be one of: ${Object.keys(LOST_REASONS).join(", ")}`);
        const lifecycleWas = opportunity.lifecycle;
        await opportunity.update({ lifecycle: "Lost", lostReason, approvalHold: null });
        await recordSystemEvent(opportunity, `Closed as lost from Approvals — ${label} ${finer} — ${LOST_REASONS[lostReason]}: ${reason}`.slice(0, 5000), actor);
        await notify({
            event: "lifecycle.changed",
            title: `${opportunity.number} marked lost`,
            body: `${customerLabel(opportunity)} — ${lifecycleWas.toLowerCase()} → lost${actor?.name ? ` by ${actor.name}` : ""}: ${label} ${finer} (${LOST_REASONS[lostReason]}). ${reason}`,
            userIds: assignedUserIds(opportunity),
            opportunity,
            actor,
        });
    }

    await touch(opportunity);
    return listApprovals(opportunity.id);
};
