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
//                checklist answers (CL-07/08/09, worked on the screen); the
//                rest are recorded directly: status, who it is with, the
//                reference, dates, a note.
//   the gate   — the chart's "All approved?": when the last required approval
//                is approved the job moves on to procurement by itself and
//                procurement is told; an approval not given sends word to the
//                salesperson, the sales manager and the owner, and goes in
//                the history. Nothing required at all leaves the move to the
//                coordinator (POST /:id/advance).

import { Op } from "sequelize";
import db from "../../../models/index.js";
import { parseId } from "../../../utils/ids.js";
import { multiLine, oneLine } from "../../../utils/text.js";
import { notify } from "../../notification/service/notificationService.js";
import { BUSINESS_OWNER_ROLE, OPERATIONS_COORDINATOR_ROLE, SALES_MANAGER_ROLE, recordSystemEvent } from "./leadWorkflowService.js";
import { customerLabel } from "./opportunityPeople.js";
import { getOpportunity, moveToNextStage, searchCondition } from "./opportunityService.js";
import { readableStages } from "./stageAccess.js";
import { APPROVAL_STATUSES } from "../model/approval.js";

const { Opportunity, Approval, BusinessUnit, User, Proposal, QuoteVersion, OpportunityHistory, Notification } = db;

const httpError = (status, message) => Object.assign(new Error(message), { status });

export const APPROVALS_STAGE = 5;
/** Types the coordinator works through a checklist on the approvals screen (prestige-fe constants/approvalChecklists.js). */
export const CHECKLIST_TYPES = ["dnsp", "da", "finance"];
const FINANCE_ROLE = "FIN";
const PROCUREMENT_ROLE = "PROC";

// ---- The catalogue and the job's list ------------------------------------------

/** The approvals a unit's jobs can need: [{ key, label }], in the unit's order. */
export const catalogueFor = (unit) =>
    (Array.isArray(unit?.approvalTypes) ? unit.approvalTypes : [])
        .filter((type) => type && typeof type.key === "string" && type.key.trim())
        .map((type) => ({ key: type.key.trim(), label: oneLine(type.label, 120) || type.key.trim() }));

const labelFor = (catalogue, key) => catalogue.find((type) => type.key === key)?.label ?? key;

const currentKeys = (opportunity) => (Array.isArray(opportunity.requiredApprovals) ? opportunity.requiredApprovals : []);

/** An array of approval keys as the API accepts it — trimmed, deduplicated, capped. */
export const sanitizeRequiredApprovals = (list) => {
    if (!Array.isArray(list)) throw httpError(400, "requiredApprovals must be an array of approval keys");
    if (list.length > 20) throw httpError(400, "requiredApprovals: at most 20 entries");
    return [...new Set(list.map((key) => oneLine(key, 20)).filter(Boolean))];
};

/** Keys must come from the unit's catalogue — a unit with no approvals section accepts none. */
export const assertApprovalKeys = (keys, unit) => {
    const known = new Set(catalogueFor(unit).map((type) => type.key));
    const unknown = keys.filter((key) => !known.has(key));
    if (unknown.length)
        throw httpError(400, `Unknown approval type${unknown.length > 1 ? "s" : ""} for this business unit: ${unknown.join(", ")}`);
    return keys;
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
 * { keys: [...] } → the opportunity. Who may: sales (leads.update),
 * estimation (estimation.update) or the coordinator (approvals.update) — the
 * route decides; this validates against the unit's catalogue, records the
 * change, and keeps the stage-5 rows in step when the job is already there.
 */
export const setRequiredApprovals = async (id, payload = {}, actor) => {
    const opportunity = await loadOpportunity(id);
    const unit = await BusinessUnit.findByPk(opportunity.businessUnitId);
    const catalogue = catalogueFor(unit);
    const keys = assertApprovalKeys(sanitizeRequiredApprovals(payload.keys ?? payload.requiredApprovals ?? []), unit);

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

// ---- Entering the stage ----------------------------------------------------------

/**
 * The job has just moved to approvals (called by moveToNextStage): create the
 * rows for what it needs and tell the operations coordinators what there is
 * to lodge — and finance, when the customer is financing the job.
 */
export const enterApprovals = async (opportunity, actor = null) => {
    const unit = await BusinessUnit.findByPk(opportunity.businessUnitId);
    const catalogue = catalogueFor(unit);
    await syncRows(opportunity, catalogue);
    const keys = currentKeys(opportunity);
    const labels = keys.map((key) => labelFor(catalogue, key));

    await notify({
        event: "approvals.started",
        title: `${opportunity.number}: approvals to lodge`,
        body: labels.length
            ? `${customerLabel(opportunity)} — ${labels.join(", ")}. Work through each on the approvals page.`
            : `${customerLabel(opportunity)} — no approvals were marked as required. Confirm none are needed, or add them on the approvals page.`,
        roleCode: OPERATIONS_COORDINATOR_ROLE,
        userIds: [opportunity.operationalCoordinatorId],
        opportunity,
        actor,
        includeActor: true,
    });
    if (keys.includes("finance"))
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
    return {
        sizeKw: watts ? Number((watts / 1000).toFixed(2)) : null,
        panels: panels.length ? panels.map((item) => `${num(item.quantity) || ""} × ${name(item)}`.trim()).join(", ") : null,
        inverter: inverters.length ? inverters.map(name).join(", ") : null,
        battery: batteries.length ? batteries.map((item) => `${name(item)}${num(item.quantity) ? ` ${num(item.quantity)} ${item.unit || "kWh"}` : ""}`).join(", ") : null,
        panelQty: panelQty || null,
    };
};

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

const siteOf = (opportunity) =>
    [opportunity.siteLine1, [opportunity.siteSuburb, opportunity.siteState, opportunity.sitePostcode].filter(Boolean).join(" ")].filter(Boolean).join(", ") || null;

const presentItem = (row) => ({
    key: row.type,
    type: row.type,
    label: row.label || row.type,
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
    checklist: row.checklist && typeof row.checklist === "object" ? row.checklist : {},
    updatedAt: row.updatedAt,
});

/** "Estimator assigned — Jane" → { action, detail }; the approvals history tab shows both lines. */
const presentHistory = (row) => {
    const [action, ...rest] = String(row.note ?? "").split(" — ");
    return { at: row.createdAt, by: row.author?.name ?? "System", action, detail: rest.join(" — ") || null };
};

const presentNotice = (row) => ({ at: row.createdAt, rule: row.event, to: row.user?.name ?? "—", priority: row.priority, message: row.body || row.title });

/**
 * One job as the approvals screens read it: the facts the checklists auto-fill
 * (customer, site, contact, phase, existing system, the accepted quote's
 * system and total), its required approvals in catalogue order, its history
 * and the notifications this stage raised. The board and the detail view
 * return the same shape, so the approvals page loads once and opens any of
 * its jobs without asking again.
 */
const presentJob = (opportunity, { catalogue, rows, accepted, salesperson = null, history = null, notifications = null }) => {
    const order = new Map(catalogue.map((type, index) => [type.key, index]));
    const items = rows
        .filter((row) => row.opportunityId === opportunity.id && row.required)
        .sort((a, b) => (order.get(a.type) ?? 99) - (order.get(b.type) ?? 99) || a.id - b.id)
        .map(presentItem);
    const snapshot = accepted?.quoteVersion?.snapshot;
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
        phase: PHASES[opportunity.electricalPhase] ?? null,
        existingSystem: existingSystemOf(opportunity),
        system: systemFromItems(snapshot?.quote?.items),
        acceptedValue: num(accepted?.grandTotal) ?? num(opportunity.acceptedValue) ?? null,
        acceptedProposal: accepted ? { id: accepted.id, number: accepted.number, quoteVersion: accepted.quoteVersion ? { id: accepted.quoteVersion.id, version: accepted.quoteVersion.version, quoteNumber: accepted.quoteVersion.quoteNumber } : null } : null,
        financeAssistance: opportunity.financeAssistance ?? null,
        financeNotes: opportunity.financeNotes ?? null,
        salesperson: salesperson ? { id: salesperson.id, name: salesperson.name } : null,
        operationalCoordinatorId: opportunity.operationalCoordinatorId,
        enteredAt: opportunity.stage === APPROVALS_STAGE ? opportunity.slaStartedAt : null,
        slaDueAt: opportunity.stage === APPROVALS_STAGE ? opportunity.slaDueAt : null,
        requiredApprovals: currentKeys(opportunity),
        catalogue,
        items,
        ...(history ? { history } : {}),
        ...(notifications ? { notifications } : {}),
    };
};

const acceptedProposalsFor = async (opportunityIds) => {
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

/**
 * The approvals page: every active job at the stage, plus jobs that moved on
 * in the last 30 days (so "ready for procurement" does not vanish the moment
 * it is). Narrowed to the stages the person may read. Each row is the whole
 * job as the detail view reads it — history and notices included — so the
 * page is one request and opening a job is none.
 */
export const approvalsBoard = async ({ businessUnitId, search } = {}, actor) => {
    const unitId = parseId(businessUnitId, "business unit id");
    const allowed = await readableStages(actor);
    const since = new Date(Date.now() - 30 * 86400000);
    const matching = searchCondition(search);
    const opportunities = await Opportunity.findAll({
        where: {
            businessUnitId: unitId,
            lifecycle: "Active",
            stage: { [Op.in]: allowed.length ? allowed : [0] },
            [Op.and]: [
                { [Op.or]: [{ stage: APPROVALS_STAGE }, { stage: { [Op.gt]: APPROVALS_STAGE }, slaStartedAt: { [Op.gte]: since } }] },
                ...(matching ? [matching] : []),
            ],
        },
        order: [["slaDueAt", "ASC"], ["updatedAt", "DESC"]],
        limit: 200,
    });
    if (!opportunities.length) return [];

    const ids = opportunities.map((opportunity) => opportunity.id);
    const [unit, rows, accepted, people, { history, notifications }] = await Promise.all([
        BusinessUnit.findByPk(unitId),
        rowsFor(ids),
        acceptedProposalsFor(ids),
        User.findAll({ where: { id: { [Op.in]: [...new Set(opportunities.map((o) => o.salespersonId).filter(Boolean))] } }, attributes: ["id", "name"] }),
        historyAndNoticesFor(ids),
    ]);
    const catalogue = catalogueFor(unit);
    const names = new Map(people.map((user) => [user.id, user]));
    const hasRows = new Set(rows.map((row) => row.opportunityId));
    return opportunities
        // A job past the stage only belongs here if it went through it.
        .filter((opportunity) => opportunity.stage === APPROVALS_STAGE || hasRows.has(opportunity.id))
        .map((opportunity) =>
            presentJob(opportunity, {
                catalogue,
                rows,
                accepted: accepted.get(opportunity.id) ?? null,
                salesperson: names.get(opportunity.salespersonId) ?? null,
                history: history.get(opportunity.id) ?? [],
                notifications: notifications.get(opportunity.id) ?? [],
            })
        );
};

// ---- Recording an approval ---------------------------------------------------------

const parseDate = (value, field) => {
    if (value === null || value === undefined || value === "") return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw httpError(400, `${field} must be a date`);
    return date;
};

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Every required approval approved — and there is at least one. */
const allApproved = async (opportunityId) => {
    const [required, waiting] = await Promise.all([
        Approval.count({ where: { opportunityId, required: true } }),
        Approval.count({ where: { opportunityId, required: true, status: { [Op.ne]: "approved" } } }),
    ]);
    return required > 0 && waiting === 0;
};

/** What a status change means for the people on the job, and the record. */
const afterStatusChange = async (opportunity, row, actor) => {
    const verb = { submitted: "lodged", approved: "approved", rejected: "not given", not_started: "reset to not started", not_applicable: "marked not applicable" }[row.status];
    const where = [row.authority, row.reference].filter(Boolean).join(" ");
    await recordSystemEvent(
        opportunity,
        `${row.label} ${verb}${where ? ` — ${where}` : ""}${row.status === "rejected" && row.notes ? ` — ${row.notes}` : ""}`.slice(0, 5000),
        actor
    );

    if (row.status === "rejected") {
        // The chart: back to the salesperson; the sales manager and owner told.
        const body = `${customerLabel(opportunity)} — ${row.label} was not given${row.notes ? `: ${row.notes}` : ""}. Relook at the options with the customer.`;
        await notify({ event: "approvals.rejected", title: `${opportunity.number}: ${row.label} not given`, body, roleCode: SALES_MANAGER_ROLE, userIds: [opportunity.salespersonId], opportunity, actor });
        await notify({ event: "approvals.rejected", title: `${opportunity.number}: ${row.label} not given`, body, roleCode: BUSINESS_OWNER_ROLE, opportunity, actor });
        return;
    }

    if (row.status === "approved" && opportunity.stage === APPROVALS_STAGE && opportunity.lifecycle === "Active" && (await allApproved(opportunity.id))) {
        await recordSystemEvent(opportunity, "All approvals received — on to procurement", actor);
        const title = `${opportunity.number}: all approvals received — start procurement`;
        const body = `${customerLabel(opportunity)} — every required approval is in. Create the job and start procurement.`;
        await moveToNextStage(opportunity, actor, { event: "approvals.complete", title, body });
        await notify({ event: "approvals.complete", title, body, roleCode: PROCUREMENT_ROLE, opportunity, actor, includeActor: true });
    }
};

/**
 * PATCH /:id/approvals/:type — { status?, authority?, reference?, submittedAt?,
 * decidedAt?, note?, documentName?, checklist? } → the job's approvals.
 * `checklist` is merged into what is held (the screen sends the answers that
 * changed). Lodging and deciding stamp the dates and who did it when not given.
 */
export const updateApproval = async (id, type, payload = {}, actor) => {
    const opportunity = await loadOpportunity(id);
    const row = await Approval.findOne({ where: { opportunityId: opportunity.id, type: oneLine(type, 20) } });
    if (!row || !row.required) throw httpError(404, "This approval is not on the job — add it to the required approvals first");

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
        const merged = { ...(isPlainObject(row.checklist) ? row.checklist : {}), ...payload.checklist };
        if (JSON.stringify(merged).length > 200000) throw httpError(400, "checklist is too large");
        update.checklist = merged;
    }

    const was = row.status;
    const changing = update.status !== undefined && update.status !== was;
    if (changing) {
        if (update.status === "submitted" && update.submittedAt === undefined && !row.submittedAt) update.submittedAt = new Date();
        if (["approved", "rejected"].includes(update.status) && update.outcomeAt === undefined && !row.outcomeAt) update.outcomeAt = new Date();
        if (!row.ownerId && actor?.id) update.ownerId = actor.id;
    }
    await row.update(update);
    if (changing) await afterStatusChange(opportunity, row, actor);
    return listApprovals(opportunity.id);
};
