// Supplier credit: the account each supplier runs for the business.
//
//   outstanding = purchases − payments − credit notes
//   available   = credit limit − outstanding (negative = over the limit)
//   overdue     = purchases past their due date not yet covered by payments.
//                 Payments are applied to purchases oldest-due first, so the
//                 overdue figure is what an aged-payables report would show.
//
// Procurement records purchases and payments (procurement.update); management
// maintains the limits and terms and may delete a transaction
// (suppliers.credit.manage). Reminders: a daily pass (runSupplierCreditCheck,
// from the SLA watcher) tells procurement and finance about overdue accounts
// and accounts over their limit; anyone with access can also send a reminder
// by hand (sendSupplierReminder).
import { Op } from "sequelize";
import db from "../../../models/index.js";
import { parseId } from "../../../utils/ids.js";
import { canAccessUnit } from "../../../utils/unitScope.js";
import { recordActivity } from "../../activity/service/activityService.js";
import { notify } from "../../notification/service/notificationService.js";
import { TRANSACTION_KINDS } from "../model/supplierTransaction.js";
import { httpError, isBlank, money, optionalText, oneOf, dateOnly, today, round2, userBrief } from "./shared.js";

const { Supplier, SupplierTransaction, BusinessUnit, Opportunity, PurchaseOrder, User } = db;

/** Roles told about supplier credit: procurement and finance. */
export const CREDIT_ROLES = ["PROC", "FIN"];

const fmt = (value) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(Number(value) || 0);

// ---- Balances -------------------------------------------------------------

/**
 * The account summary from its transactions, as of `asOf` (YYYY-MM-DD):
 * { outstanding, paid, purchased, available, overLimit, overdue, overdueCount, oldestOverdueAt, nextDueAt }.
 */
export const summarise = (supplier, transactions, asOf = today()) => {
    let purchased = 0;
    let paid = 0;
    const purchases = [];
    for (const t of transactions) {
        const amount = Number(t.amount) || 0;
        if (t.kind === "purchase") {
            purchased += amount;
            purchases.push({ amount, dueAt: t.dueAt ?? t.transactedAt, id: t.id });
        } else paid += amount; // payments and credit notes both reduce what is owed
    }
    // Apply what has been paid to the purchases oldest-due first.
    purchases.sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)) || a.id - b.id);
    let remaining = paid;
    let overdue = 0;
    let overdueCount = 0;
    let oldestOverdueAt = null;
    let nextDueAt = null;
    for (const p of purchases) {
        const covered = Math.min(remaining, p.amount);
        remaining -= covered;
        const unpaid = round2(p.amount - covered);
        if (unpaid <= 0) continue;
        if (p.dueAt && p.dueAt < asOf) {
            overdue += unpaid;
            overdueCount += 1;
            if (!oldestOverdueAt || p.dueAt < oldestOverdueAt) oldestOverdueAt = p.dueAt;
        } else if (p.dueAt && (!nextDueAt || p.dueAt < nextDueAt)) nextDueAt = p.dueAt;
    }
    const outstanding = round2(purchased - paid);
    const limit = Number(supplier.creditLimit) || 0;
    return {
        creditLimit: round2(limit),
        paymentTermsDays: supplier.paymentTermsDays,
        purchased: round2(purchased),
        paid: round2(paid),
        outstanding,
        available: round2(limit - outstanding),
        overLimit: limit > 0 && outstanding > limit,
        overdue: round2(overdue),
        overdueCount,
        oldestOverdueAt,
        nextDueAt,
        asOf,
    };
};

/** supplier id → summary, for a list of suppliers in one query. */
export const creditSummariesFor = async (supplierIds) => {
    if (!supplierIds.length) return new Map();
    const [suppliers, transactions] = await Promise.all([
        Supplier.findAll({ where: { id: supplierIds }, attributes: ["id", "creditLimit", "paymentTermsDays"] }),
        SupplierTransaction.findAll({ where: { supplierId: supplierIds }, attributes: ["id", "supplierId", "kind", "amount", "transactedAt", "dueAt"] }),
    ]);
    const bySupplier = new Map(suppliers.map((s) => [s.id, []]));
    for (const t of transactions) bySupplier.get(t.supplierId)?.push(t);
    const asOf = today();
    return new Map(suppliers.map((s) => [s.id, summarise(s, bySupplier.get(s.id) ?? [], asOf)]));
};

// ---- Transactions -----------------------------------------------------------

const TRANSACTION_INCLUDE = [
    { model: User, as: "recordedBy", attributes: ["id", "name"] },
    { model: BusinessUnit, as: "businessUnit", attributes: ["id", "code", "name"] },
    { model: Opportunity, as: "opportunity", attributes: ["id", "number"] },
    { model: PurchaseOrder, as: "purchaseOrder", attributes: ["id", "ref"] },
];

export const presentTransaction = (row) => ({
    id: row.id,
    supplierId: row.supplierId,
    kind: row.kind,
    amount: Number(row.amount),
    reference: row.reference ?? null,
    transactedAt: row.transactedAt,
    dueAt: row.dueAt ?? null,
    note: row.note ?? null,
    businessUnit: row.businessUnit ? { id: row.businessUnit.id, code: row.businessUnit.code, name: row.businessUnit.name } : null,
    opportunity: row.opportunity ? { id: row.opportunity.id, number: row.opportunity.number } : null,
    purchaseOrder: row.purchaseOrder ? { id: row.purchaseOrder.id, ref: row.purchaseOrder.ref } : null,
    recordedBy: userBrief(row.recordedBy),
    createdAt: row.createdAt,
});

const loadSupplier = async (id) => {
    const row = await Supplier.findByPk(parseId(id, "supplier id"));
    if (!row) throw httpError(404, "Supplier not found");
    return row;
};

/** One supplier's account: the summary and every transaction, newest first. */
export const getSupplierCredit = async (id) => {
    const supplier = await loadSupplier(id);
    const rows = await SupplierTransaction.findAll({
        where: { supplierId: supplier.id },
        include: TRANSACTION_INCLUDE,
        order: [["transactedAt", "DESC"], ["id", "DESC"]],
    });
    return {
        supplier: { id: supplier.id, code: supplier.code, name: supplier.name, isActive: supplier.isActive, creditNotes: supplier.creditNotes ?? null },
        summary: summarise(supplier, rows),
        transactions: rows.map(presentTransaction),
    };
};

/** The credit position of every active supplier, worst first: those over the limit and overdue on top. */
export const creditOverview = async ({ includeInactive } = {}) => {
    const where = includeInactive === "1" || includeInactive === "true" ? {} : { isActive: true };
    const suppliers = await Supplier.findAll({ where, order: [["name", "ASC"]] });
    const summaries = await creditSummariesFor(suppliers.map((s) => s.id));
    const rows = suppliers.map((s) => ({ supplier: { id: s.id, code: s.code, name: s.name, isActive: s.isActive }, ...summaries.get(s.id) }));
    rows.sort((a, b) => Number(b.overLimit) - Number(a.overLimit) || b.overdue - a.overdue || b.outstanding - a.outstanding);
    const totals = rows.reduce(
        (acc, r) => ({
            creditLimit: round2(acc.creditLimit + r.creditLimit),
            outstanding: round2(acc.outstanding + r.outstanding),
            available: round2(acc.available + r.available),
            overdue: round2(acc.overdue + r.overdue),
            overLimit: acc.overLimit + (r.overLimit ? 1 : 0),
            withOverdue: acc.withOverdue + (r.overdue > 0 ? 1 : 0),
        }),
        { creditLimit: 0, outstanding: 0, available: 0, overdue: 0, overLimit: 0, withOverdue: 0 }
    );
    return { data: rows, totals };
};

/**
 * { kind: purchase | payment | credit_note, amount, reference?, transactedAt?, dueAt?, note?,
 *   businessUnitId?, opportunityId?, purchaseOrderId? }
 * A purchase without dueAt falls due after the supplier's payment terms.
 * Pushing the account over its limit is allowed but reported (warnings) and
 * notified — the limit is the supplier's, and the goods may already be ordered.
 */
export const recordTransaction = async (id, payload = {}, actor, ctx) => {
    const supplier = await loadSupplier(id);
    const kind = oneOf(payload.kind, TRANSACTION_KINDS, "kind");
    const amount = money(payload.amount, "amount", { min: 0.01 });
    const transactedAt = dateOnly(payload.transactedAt, "transactedAt") ?? today();
    let dueAt = dateOnly(payload.dueAt, "dueAt");
    if (kind === "purchase" && !dueAt) {
        const due = new Date(transactedAt);
        due.setUTCDate(due.getUTCDate() + (supplier.paymentTermsDays || 0));
        dueAt = due.toISOString().slice(0, 10);
    }
    if (kind !== "purchase") dueAt = null;

    let businessUnitId = null;
    if (!isBlank(payload.businessUnitId)) {
        businessUnitId = parseId(payload.businessUnitId, "businessUnitId");
        if (!canAccessUnit(actor, businessUnitId)) throw httpError(403, "This business unit is outside your assignments");
        if (!(await BusinessUnit.findByPk(businessUnitId, { attributes: ["id"] }))) throw httpError(400, "Unknown business unit");
    }
    let opportunityId = null;
    if (!isBlank(payload.opportunityId)) {
        const opportunity = await Opportunity.findByPk(parseId(payload.opportunityId, "opportunityId"), { attributes: ["id", "businessUnitId"] });
        if (!opportunity || !canAccessUnit(actor, opportunity.businessUnitId)) throw httpError(404, "Opportunity not found");
        opportunityId = opportunity.id;
        businessUnitId = businessUnitId ?? opportunity.businessUnitId;
    }
    let purchaseOrderId = null;
    if (!isBlank(payload.purchaseOrderId)) {
        const po = await PurchaseOrder.findByPk(parseId(payload.purchaseOrderId, "purchaseOrderId"), { attributes: ["id", "opportunityId"] });
        if (!po || (opportunityId && po.opportunityId !== opportunityId)) throw httpError(400, "Unknown purchase order for this job");
        purchaseOrderId = po.id;
    }

    const before = summarise(supplier, await SupplierTransaction.findAll({ where: { supplierId: supplier.id } }));
    const row = await SupplierTransaction.create({
        supplierId: supplier.id,
        businessUnitId,
        opportunityId,
        purchaseOrderId,
        kind,
        amount,
        reference: optionalText(payload.reference, "reference", 120),
        transactedAt,
        dueAt,
        note: optionalText(payload.note, "note", 1000),
        recordedById: actor?.id ?? null,
    });
    const after = summarise(supplier, await SupplierTransaction.findAll({ where: { supplierId: supplier.id } }));

    await recordActivity({
        actor, ctx, businessUnitId, entityType: "supplier", entityId: supplier.id, entityLabel: supplier.name,
        action: `${kind}_recorded`, meta: { transactionId: row.id, amount, reference: row.reference, dueAt, outstanding: after.outstanding },
    });

    const warnings = [];
    if (after.overLimit && !before.overLimit) {
        warnings.push(`${supplier.name} is now over its credit limit: ${fmt(after.outstanding)} outstanding against ${fmt(after.creditLimit)}`);
        await notifyCreditRoles({
            event: "supplier.credit.limit",
            title: `${supplier.name} is over its credit limit`,
            body: `${fmt(after.outstanding)} outstanding against a ${fmt(after.creditLimit)} limit after ${row.reference ? `${kind} ${row.reference}` : `a ${kind}`} of ${fmt(amount)}${actor?.name ? ` recorded by ${actor.name}` : ""}.`,
            businessUnitId,
            actor,
            dedupeKey: `supplier-limit:${supplier.id}:${row.id}`,
        });
    } else if (after.overLimit) warnings.push(`${supplier.name} remains over its credit limit (${fmt(after.available)} available)`);

    const fresh = await SupplierTransaction.findByPk(row.id, { include: TRANSACTION_INCLUDE });
    return { transaction: presentTransaction(fresh), summary: after, warnings };
};

/** Management removes a transaction recorded in error. */
export const deleteTransaction = async (id, transactionId, actor, ctx) => {
    const supplier = await loadSupplier(id);
    const row = await SupplierTransaction.findOne({ where: { id: parseId(transactionId, "transaction id"), supplierId: supplier.id } });
    if (!row) throw httpError(404, "Transaction not found");
    await row.destroy();
    await recordActivity({
        actor, ctx, businessUnitId: row.businessUnitId, entityType: "supplier", entityId: supplier.id, entityLabel: supplier.name,
        action: "transaction_deleted", meta: { transactionId: row.id, kind: row.kind, amount: Number(row.amount), reference: row.reference },
    });
    return getSupplierCredit(supplier.id);
};

// ---- Notifications and reminders -------------------------------------------

/**
 * Tells every procurement and finance person. Suppliers are shared by the
 * business units, so without a unit the notice goes to those roles in every
 * active unit (the dedupe key keeps it to one per person).
 */
const notifyCreditRoles = async ({ event, title, body, businessUnitId = null, actor = null, dedupeKey = null, extraUserIds = [] }) => {
    const units = businessUnitId
        ? [businessUnitId]
        : (await BusinessUnit.findAll({ where: { status: { [Op.ne]: "inactive" } }, attributes: ["id"] })).map((u) => u.id);
    let created = 0;
    const recipients = new Map();
    for (const unitId of units) {
        for (const roleCode of CREDIT_ROLES) {
            const result = await notify({ event, title, body, roleCode, userIds: extraUserIds, businessUnitId: unitId, actor, dedupeKey, includeActor: true });
            created += result.created;
            for (const user of result.recipients) recipients.set(user.id, user);
        }
    }
    return { created, recipients: [...recipients.values()] };
};

/**
 * A reminder about a supplier's account sent by hand: { note?, businessUnitId?, userIds? }
 * → the people told. Goes to procurement and finance (and any named users).
 */
export const sendSupplierReminder = async (id, payload = {}, actor, ctx) => {
    const supplier = await loadSupplier(id);
    const summary = summarise(supplier, await SupplierTransaction.findAll({ where: { supplierId: supplier.id } }));
    const note = optionalText(payload.note, "note", 1000);
    const businessUnitId = isBlank(payload.businessUnitId) ? null : parseId(payload.businessUnitId, "businessUnitId");
    if (businessUnitId && !canAccessUnit(actor, businessUnitId)) throw httpError(403, "This business unit is outside your assignments");
    const userIds = Array.isArray(payload.userIds) ? payload.userIds.map((u) => parseId(u, "userIds entry")) : [];
    const state = summary.overdue > 0
        ? `${fmt(summary.overdue)} overdue (${summary.overdueCount} invoice${summary.overdueCount === 1 ? "" : "s"}, oldest due ${summary.oldestOverdueAt})`
        : summary.overLimit
          ? `over the credit limit by ${fmt(-summary.available)}`
          : `${fmt(summary.outstanding)} outstanding, ${fmt(summary.available)} available${summary.nextDueAt ? `, next due ${summary.nextDueAt}` : ""}`;
    const result = await notifyCreditRoles({
        event: "supplier.reminder",
        title: `Supplier reminder: ${supplier.name}`,
        body: `${state}.${note ? ` ${note}` : ""}${actor?.name ? ` — ${actor.name}` : ""}`,
        businessUnitId,
        actor,
        extraUserIds: userIds,
    });
    await recordActivity({
        actor, ctx, businessUnitId, entityType: "supplier", entityId: supplier.id, entityLabel: supplier.name,
        action: "reminder_sent", meta: { note, recipients: result.recipients.map((u) => u.name) },
    });
    return { notified: result.recipients.length, recipients: result.recipients.map(userBrief), summary };
};

/**
 * The daily pass (SLA watcher): one notice per person per supplier per day for
 * every account with an overdue amount, and one for every account over its
 * limit. Returns how many notices went out.
 */
export const runSupplierCreditCheck = async () => {
    const suppliers = await Supplier.findAll({ where: { isActive: true } });
    if (!suppliers.length) return 0;
    const summaries = await creditSummariesFor(suppliers.map((s) => s.id));
    const day = today();
    let raised = 0;
    for (const supplier of suppliers) {
        const s = summaries.get(supplier.id);
        if (!s) continue;
        if (s.overdue > 0) {
            const { created } = await notifyCreditRoles({
                event: "supplier.credit.overdue",
                title: `${supplier.name}: ${fmt(s.overdue)} overdue`,
                body: `${s.overdueCount} purchase${s.overdueCount === 1 ? "" : "s"} past due (oldest ${s.oldestOverdueAt}); ${fmt(s.outstanding)} outstanding in all.`,
                dedupeKey: `supplier-overdue:${supplier.id}:${day}`,
            });
            raised += created;
        }
        if (s.overLimit) {
            const { created } = await notifyCreditRoles({
                event: "supplier.credit.limit",
                title: `${supplier.name} is over its credit limit`,
                body: `${fmt(s.outstanding)} outstanding against a ${fmt(s.creditLimit)} limit.`,
                dedupeKey: `supplier-limit:${supplier.id}:${day}`,
            });
            raised += created;
        }
    }
    return raised;
};
