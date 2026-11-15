// Customer payments: what each customer owes on a job, GST included, and what
// has come in against it. One row per amount owed (a deposit, a progress
// claim, the final invoice); receipts are recorded against the row. The
// status follows from the figures and the due date — never set by hand except
// to cancel.
import crypto from "node:crypto";
import { Op } from "sequelize";
import db from "../../../models/index.js";
import { parseId } from "../../../utils/ids.js";
import { pagingOf } from "../../../utils/pagination.js";
import { assertUnitAccess, canAccessUnit, unitScopeOf } from "../../../utils/unitScope.js";
import { recordActivity, diff } from "../../activity/service/activityService.js";
import { notify } from "../../notification/service/notificationService.js";
import { recordSystemEvent } from "../../opportunity/service/leadWorkflowService.js";
import { assignedUserIds, customerLabel } from "../../opportunity/service/opportunityPeople.js";
import { PAYMENT_STATUSES, RECEIPT_METHODS } from "../model/customerPayment.js";
import { httpError, isBlank, requiredText, optionalText, optionalLongText, money, dateOnly, oneOf, today, round2, userBrief } from "../../equipment/service/shared.js";

const { CustomerPayment, Opportunity, BusinessUnit, Project, User } = db;

const fmt = (value) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(Number(value) || 0);

const INCLUDE = [
    {
        model: Opportunity,
        as: "opportunity",
        attributes: ["id", "number", "stage", "lifecycle", "businessUnitId", "customerLegalName", "customerTradingName", "customerEmail", "customerPhone", "salespersonId", "leadOwnerId", "estimatorId", "operationalCoordinatorId", "deliveryOwnerId"],
    },
    { model: BusinessUnit, as: "businessUnit", attributes: ["id", "code", "name"] },
    { model: Project, as: "project", attributes: ["id", "code", "status", "paymentType"] },
    { model: User, as: "createdBy", attributes: ["id", "name"] },
];

export const receivedOf = (row) => round2((row.receipts ?? []).reduce((sum, r) => sum + (Number(r.amount) || 0), 0));

/** unpaid | partial | paid | overdue | cancelled from the figures (cancelled stays cancelled). */
export const statusOf = (row, asOf = today()) => {
    if (row.status === "cancelled") return "cancelled";
    const inc = Number(row.amountInc) || 0;
    const received = receivedOf(row);
    if (inc > 0 && received >= inc - 0.005) return "paid";
    if (row.dueAt && row.dueAt < asOf) return "overdue";
    return received > 0 ? "partial" : "unpaid";
};

export const presentPayment = (row) => {
    const received = receivedOf(row);
    const status = statusOf(row);
    return {
        id: row.id,
        description: row.description,
        milestone: row.milestone ?? null,
        job: row.opportunity
            ? { id: row.opportunity.id, number: row.opportunity.number, customer: customerLabel(row.opportunity), email: row.opportunity.customerEmail ?? null, phone: row.opportunity.customerPhone ?? null }
            : { id: row.opportunityId },
        businessUnit: row.businessUnit ? { id: row.businessUnit.id, code: row.businessUnit.code, name: row.businessUnit.name } : { id: row.businessUnitId },
        project: row.project ? { id: row.project.id, code: row.project.code, status: row.project.status, paymentType: row.project.paymentType } : null,
        amountEx: round2(row.amountEx),
        gstRatePct: Number(row.gstRatePct),
        gstAmount: round2(row.gstAmount),
        amountInc: round2(row.amountInc),
        received,
        balance: status === "cancelled" ? 0 : round2(Number(row.amountInc) - received),
        dueAt: row.dueAt ?? null,
        overdueDays: status === "overdue" ? Math.max(0, Math.round((new Date(today()) - new Date(row.dueAt)) / 86400000)) : 0,
        invoiceNumber: row.invoiceNumber ?? null,
        status,
        receipts: row.receipts ?? [],
        notes: row.notes ?? null,
        createdBy: userBrief(row.createdBy),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
};

const gstFigures = (amountEx, ratePct) => {
    const gst = round2(amountEx * (ratePct / 100));
    return { amountEx: round2(amountEx), gstRatePct: ratePct, gstAmount: gst, amountInc: round2(amountEx + gst) };
};

/** amountEx (+ gstRatePct) or amountInc: either way the three figures come back consistent. */
const amountsFrom = (payload, current = null) => {
    let ratePct = Number(current?.gstRatePct ?? 10);
    if (payload.gstRatePct !== undefined) {
        ratePct = Number(payload.gstRatePct);
        if (!Number.isFinite(ratePct) || ratePct < 0 || ratePct > 100) throw httpError(400, "gstRatePct must be between 0 and 100");
        ratePct = round2(ratePct);
    }
    if (payload.amountInc !== undefined && payload.amountEx === undefined) {
        const inc = money(payload.amountInc, "amountInc");
        const ex = round2(inc / (1 + ratePct / 100));
        return { amountEx: ex, gstRatePct: ratePct, gstAmount: round2(inc - ex), amountInc: inc };
    }
    if (payload.amountEx !== undefined) return gstFigures(money(payload.amountEx, "amountEx"), ratePct);
    if (current) return gstFigures(Number(current.amountEx), ratePct);
    throw httpError(400, "amountEx (ex GST) or amountInc (inc GST) is required");
};

const loadPayment = async (id, actor) => {
    const row = await CustomerPayment.findByPk(parseId(id, "payment id"), { include: INCLUDE });
    if (!row || !canAccessUnit(actor, row.businessUnitId)) throw httpError(404, "Customer payment not found");
    return row;
};

const refreshStatus = async (row) => {
    const status = statusOf(row);
    if (status !== row.status) await row.update({ status });
    return row;
};

const labelOf = (row) => `${row.opportunity?.number ?? ""} ${row.description}`.trim();

// ---- Reads ----------------------------------------------------------------

export const totalsOf = (rows) =>
    rows.reduce(
        (acc, p) => {
            if (p.status === "cancelled") return acc;
            acc.owedEx = round2(acc.owedEx + p.amountEx);
            acc.gst = round2(acc.gst + p.gstAmount);
            acc.owedInc = round2(acc.owedInc + p.amountInc);
            acc.received = round2(acc.received + p.received);
            acc.balance = round2(acc.balance + p.balance);
            if (p.status === "overdue") {
                acc.overdue = round2(acc.overdue + p.balance);
                acc.overdueCount += 1;
            }
            return acc;
        },
        { owedEx: 0, gst: 0, owedInc: 0, received: 0, balance: 0, overdue: 0, overdueCount: 0 }
    );

/** ?businessUnitId=&opportunityId=&projectId=&status=&outstanding=1&search=&page=&pageSize= → rows + totals over every match. */
export const listPayments = async (query = {}, actor) => {
    const where = {};
    const scope = unitScopeOf(actor);
    if (!isBlank(query.businessUnitId)) {
        const unitId = parseId(query.businessUnitId, "businessUnitId");
        assertUnitAccess(actor, unitId);
        where.businessUnitId = unitId;
    } else if (scope) where.businessUnitId = { [Op.in]: scope };
    if (!isBlank(query.opportunityId)) where.opportunityId = parseId(query.opportunityId, "opportunityId");
    if (!isBlank(query.projectId)) where.projectId = parseId(query.projectId, "projectId");
    if (query.search) {
        const term = `%${String(query.search).trim().slice(0, 100)}%`;
        where[Op.or] = [
            { description: { [Op.iLike]: term } },
            { invoiceNumber: { [Op.iLike]: term } },
            { "$opportunity.number$": { [Op.iLike]: term } },
            { "$opportunity.customer_legal_name$": { [Op.iLike]: term } },
        ];
    }
    // The status is derived, so it is filtered after the read; the page is cut from the filtered set.
    const rows = await CustomerPayment.findAll({ where, include: INCLUDE, order: [["dueAt", "ASC"], ["id", "ASC"]], subQuery: false });
    let data = rows.map(presentPayment);
    if (query.status) {
        const wanted = oneOf(query.status, PAYMENT_STATUSES, "status");
        data = data.filter((p) => p.status === wanted);
    }
    if (query.outstanding === "1" || query.outstanding === "true") data = data.filter((p) => p.balance > 0);
    const paging = pagingOf(query, { defaultSize: 12, maxSize: 200 });
    return { data: data.slice(paging.offset, paging.offset + paging.limit), total: data.length, page: paging.page, pageSize: paging.pageSize, totals: totalsOf(data) };
};

export const getPayment = async (id, actor) => presentPayment(await refreshStatus(await loadPayment(id, actor)));

// ---- Writes ---------------------------------------------------------------

/** { opportunityId, description, amountEx | amountInc, gstRatePct?, milestone?, dueAt?, invoiceNumber?, projectId?, notes? } */
export const createPayment = async (payload = {}, actor, ctx) => {
    const opportunity = await Opportunity.findByPk(parseId(payload.opportunityId, "opportunityId"));
    if (!opportunity || !canAccessUnit(actor, opportunity.businessUnitId)) throw httpError(404, "Opportunity not found");
    let project = null;
    if (!isBlank(payload.projectId)) {
        project = await Project.findByPk(parseId(payload.projectId, "projectId"));
        if (!project || project.opportunityId !== opportunity.id) throw httpError(400, "That project is not this job's");
    } else project = await Project.findOne({ where: { opportunityId: opportunity.id } });
    const row = await CustomerPayment.create({
        opportunityId: opportunity.id,
        businessUnitId: opportunity.businessUnitId,
        projectId: project?.id ?? null,
        description: requiredText(payload.description, "description", 255),
        milestone: optionalText(payload.milestone, "milestone", 40),
        ...amountsFrom(payload),
        dueAt: dateOnly(payload.dueAt, "dueAt"),
        invoiceNumber: optionalText(payload.invoiceNumber, "invoiceNumber", 60),
        notes: optionalLongText(payload.notes, "notes", 5000),
        receipts: [],
        createdById: actor?.id ?? null,
    });
    await refreshStatus(row);
    await recordSystemEvent(opportunity, `Customer payment recorded as owed: ${row.description} ${fmt(row.amountInc)} inc GST${row.dueAt ? `, due ${row.dueAt}` : ""}.`, actor);
    await recordActivity({
        actor, ctx, businessUnitId: row.businessUnitId, entityType: "customer_payment", entityId: row.id,
        entityLabel: `${opportunity.number} ${row.description}`, action: "created", meta: { amountInc: round2(row.amountInc), dueAt: row.dueAt },
    });
    return getPayment(row.id, actor);
};

export const updatePayment = async (id, payload = {}, actor, ctx) => {
    const row = await loadPayment(id, actor);
    if (row.status === "cancelled" && payload.status !== "unpaid") throw httpError(409, "A cancelled payment can only be reinstated (status: unpaid)");
    const before = { ...row.get({ plain: true }) }; // a copy: without includes Sequelize hands back the live dataValues
    const updates = {};
    if (payload.description !== undefined) updates.description = requiredText(payload.description, "description", 255);
    if (payload.milestone !== undefined) updates.milestone = optionalText(payload.milestone, "milestone", 40);
    if (payload.amountEx !== undefined || payload.amountInc !== undefined || payload.gstRatePct !== undefined) Object.assign(updates, amountsFrom(payload, row));
    if (payload.dueAt !== undefined) updates.dueAt = dateOnly(payload.dueAt, "dueAt");
    if (payload.invoiceNumber !== undefined) updates.invoiceNumber = optionalText(payload.invoiceNumber, "invoiceNumber", 60);
    if (payload.notes !== undefined) updates.notes = optionalLongText(payload.notes, "notes", 5000);
    if (payload.status !== undefined) {
        const status = oneOf(payload.status, ["cancelled", "unpaid"], "status");
        if (status === "cancelled" && receivedOf(row) > 0) throw httpError(409, "Money has been received against this payment — it cannot be cancelled");
        updates.status = status;
    }
    if (!Object.keys(updates).length) throw httpError(400, "No fields provided");
    if (updates.amountInc !== undefined && updates.amountInc < receivedOf(row)) throw httpError(400, `${fmt(receivedOf(row))} has already been received — the amount cannot be less than that`);
    await row.update(updates);
    await refreshStatus(row);
    const changes = diff(before, row.get({ plain: true }), [...Object.keys(updates), "status"]);
    if (changes)
        await recordActivity({
            actor, ctx, businessUnitId: row.businessUnitId, entityType: "customer_payment", entityId: row.id, entityLabel: labelOf(row),
            action: updates.status === "cancelled" ? "cancelled" : "updated", changes,
        });
    return getPayment(row.id, actor);
};

/** { amount, receivedAt?, method?, reference?, note? } → the payment with the receipt added. Overpaying is refused. */
export const addReceipt = async (id, payload = {}, actor, ctx) => {
    const row = await loadPayment(id, actor);
    if (row.status === "cancelled") throw httpError(409, "This payment is cancelled");
    const amount = money(payload.amount, "amount", { min: 0.01 });
    const balance = round2(Number(row.amountInc) - receivedOf(row));
    if (amount > balance + 0.005) throw httpError(400, `Only ${fmt(balance)} is outstanding on this payment`);
    const receipt = {
        id: crypto.randomUUID(),
        amount,
        receivedAt: dateOnly(payload.receivedAt, "receivedAt") ?? today(),
        method: isBlank(payload.method) ? null : oneOf(payload.method, RECEIPT_METHODS, "method"),
        reference: optionalText(payload.reference, "reference", 120),
        note: optionalText(payload.note, "note", 500),
        recordedById: actor?.id ?? null,
        recordedBy: actor?.name ?? null,
        recordedAt: new Date().toISOString(),
    };
    await row.update({ receipts: [...(row.receipts ?? []), receipt] });
    await refreshStatus(row);
    const opportunity = row.opportunity ?? (await Opportunity.findByPk(row.opportunityId));
    const left = round2(balance - amount);
    await recordSystemEvent(
        opportunity,
        `Payment received: ${fmt(amount)} against ${row.description}${receipt.reference ? ` (${receipt.reference})` : ""} — ${left <= 0 ? "paid in full" : `${fmt(left)} still owing`}.`,
        actor
    );
    await recordActivity({
        actor, ctx, businessUnitId: row.businessUnitId, entityType: "customer_payment", entityId: row.id, entityLabel: labelOf(row),
        action: "receipt_added", meta: { amount, reference: receipt.reference, method: receipt.method, status: row.status },
    });
    await notify({
        event: "customer_payment.received",
        title: `${opportunity.number}: ${fmt(amount)} received`,
        body: `${customerLabel(opportunity)} paid ${fmt(amount)} against ${row.description}${left <= 0 ? " — paid in full." : `; ${fmt(left)} still owing.`}`,
        userIds: assignedUserIds(opportunity),
        opportunity,
        actor,
    });
    return getPayment(row.id, actor);
};

export const removeReceipt = async (id, receiptId, actor, ctx) => {
    const row = await loadPayment(id, actor);
    const receipt = (row.receipts ?? []).find((r) => r.id === receiptId);
    if (!receipt) throw httpError(404, "Receipt not found");
    await row.update({ receipts: row.receipts.filter((r) => r.id !== receiptId) });
    await refreshStatus(row);
    await recordActivity({
        actor, ctx, businessUnitId: row.businessUnitId, entityType: "customer_payment", entityId: row.id, entityLabel: labelOf(row),
        action: "receipt_removed", meta: { amount: receipt.amount, reference: receipt.reference },
    });
    return getPayment(row.id, actor);
};

export const deletePayment = async (id, actor, ctx) => {
    const row = await loadPayment(id, actor);
    if (receivedOf(row) > 0) throw httpError(409, "Money has been received against this payment — cancel it instead of deleting it");
    await row.destroy();
    await recordActivity({ actor, ctx, businessUnitId: row.businessUnitId, entityType: "customer_payment", entityId: row.id, entityLabel: labelOf(row), action: "deleted" });
};

/** The unit's position for the dashboard. */
export const paymentStats = async (businessUnitId) => {
    const rows = await CustomerPayment.findAll({ where: { businessUnitId }, include: INCLUDE });
    return totalsOf(rows.map(presentPayment));
};

/** Daily (SLA watcher): the job's people and finance hear once per payment per day while it is overdue. */
export const runCustomerPaymentOverdueCheck = async () => {
    const asOf = today();
    const rows = await CustomerPayment.findAll({ where: { status: { [Op.ne]: "cancelled" }, dueAt: { [Op.lt]: asOf } }, include: INCLUDE });
    let raised = 0;
    for (const row of rows) {
        const p = presentPayment(row);
        if (p.status !== "overdue" || !row.opportunity) continue;
        await refreshStatus(row);
        const { created } = await notify({
            event: "customer_payment.overdue",
            title: `${p.job.number}: ${fmt(p.balance)} overdue`,
            body: `${p.job.customer} — ${row.description} was due ${row.dueAt}, ${p.overdueDays} day${p.overdueDays === 1 ? "" : "s"} ago.`,
            userIds: assignedUserIds(row.opportunity),
            roleCode: "FIN",
            opportunity: row.opportunity,
            dedupeKey: `customer-payment-overdue:${row.id}:${asOf}`,
        });
        raised += created;
    }
    return raised;
};
