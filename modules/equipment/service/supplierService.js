// Suppliers: contact details (equipment.update) and credit details — limit and
// payment terms (suppliers.credit.manage). The account's balances come from
// supplierCreditService and ride on every supplier read.
import { Op } from "sequelize";
import db from "../../../models/index.js";
import { parseId } from "../../../utils/ids.js";
import { pagingOf } from "../../../utils/pagination.js";
import { recordActivity, diff } from "../../activity/service/activityService.js";
import { creditSummariesFor } from "./supplierCreditService.js";
import { httpError, requiredText, optionalText, optionalLongText, money, wholeNumber, nextCode } from "./shared.js";

const { Supplier, EquipmentSupplierPrice, sequelize } = db;

const CODE_PREFIX = "SUP-";
const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

export const presentSupplier = (row, credit = null, { withCredit = true } = {}) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    contactName: row.contactName ?? null,
    email: row.email ?? null,
    phone: row.phone ?? null,
    address: row.address ?? null,
    abn: row.abn ?? null,
    website: row.website ?? null,
    notes: row.notes ?? null,
    isActive: row.isActive,
    itemCount: row.itemCount !== undefined ? Number(row.itemCount) : undefined,
    ...(withCredit
        ? {
              paymentTermsDays: row.paymentTermsDays,
              creditLimit: Number(row.creditLimit),
              creditNotes: row.creditNotes ?? null,
              credit: credit ?? null,
          }
        : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
});

const assertNameFree = async (name, exceptId = null) => {
    const rows = await Supplier.findAll({ where: sequelize.where(sequelize.fn("lower", sequelize.col("name")), name.toLowerCase()) });
    const other = rows.find((row) => row.id !== exceptId);
    if (other) throw httpError(409, `A supplier named "${other.name}" already exists`);
};

const cleanEmail = (value) => {
    const email = optionalText(value, "email", 254);
    if (email && !EMAIL_RE.test(email)) throw httpError(400, "email must be a valid address");
    return email ? email.toLowerCase() : null;
};

export const findSupplier = async (id) => {
    const row = await Supplier.findByPk(parseId(id, "supplier id"));
    if (!row) throw httpError(404, "Supplier not found");
    return row;
};

const contactFields = (payload, { partial = false } = {}) => {
    const out = {};
    const has = (key) => !partial || payload[key] !== undefined;
    if (has("name")) out.name = requiredText(payload.name, "name", 200);
    if (has("contactName")) out.contactName = optionalText(payload.contactName, "contactName", 120);
    if (has("email")) out.email = cleanEmail(payload.email);
    if (has("phone")) out.phone = optionalText(payload.phone, "phone", 30);
    if (has("address")) out.address = optionalText(payload.address, "address", 500);
    if (has("abn")) out.abn = optionalText(payload.abn, "abn", 20);
    if (has("website")) out.website = optionalText(payload.website, "website", 300);
    if (has("notes")) out.notes = optionalLongText(payload.notes, "notes", 5000);
    if (has("isActive") && payload.isActive !== undefined) out.isActive = Boolean(payload.isActive);
    return out;
};

const creditFields = (payload) => {
    const out = {};
    if (payload.creditLimit !== undefined) out.creditLimit = money(payload.creditLimit, "creditLimit");
    if (payload.paymentTermsDays !== undefined) out.paymentTermsDays = wholeNumber(payload.paymentTermsDays, "paymentTermsDays", { min: 0 });
    if (payload.creditNotes !== undefined) out.creditNotes = optionalLongText(payload.creditNotes, "creditNotes", 5000);
    return out;
};

const CREDIT_KEYS = ["creditLimit", "paymentTermsDays", "creditNotes"];
const touchesCredit = (payload) => CREDIT_KEYS.some((key) => payload[key] !== undefined);

/**
 * ?search=&includeInactive=&page=&pageSize= → paged suppliers with their credit
 * summary (when the caller may see it: `withCredit`).
 */
export const listSuppliers = async (query = {}, { withCredit = true } = {}) => {
    const where = {};
    if (!(query.includeInactive === "1" || query.includeInactive === "true")) where.isActive = true;
    if (query.search) {
        const term = `%${String(query.search).trim().slice(0, 100)}%`;
        where[Op.or] = [{ name: { [Op.iLike]: term } }, { code: { [Op.iLike]: term } }, { contactName: { [Op.iLike]: term } }, { email: { [Op.iLike]: term } }];
    }
    const paging = pagingOf(query, { defaultSize: 25, maxSize: 200 });
    const { rows, count } = await Supplier.findAndCountAll({ where, order: [["name", "ASC"]], limit: paging.limit, offset: paging.offset });
    const ids = rows.map((r) => r.id);
    const [credit, items] = await Promise.all([
        withCredit ? creditSummariesFor(ids) : new Map(),
        ids.length
            ? EquipmentSupplierPrice.findAll({ attributes: ["supplierId", [sequelize.fn("COUNT", sequelize.col("id")), "n"]], where: { supplierId: ids }, group: ["supplier_id"], raw: true })
            : [],
    ]);
    const itemCount = new Map(items.map((r) => [Number(r.supplierId), Number(r.n)]));
    return {
        data: rows.map((row) => presentSupplier(Object.assign(row, { itemCount: itemCount.get(row.id) ?? 0 }), credit.get(row.id) ?? null, { withCredit })),
        total: count,
        page: paging.page,
        pageSize: paging.pageSize,
    };
};

export const getSupplier = async (id, { withCredit = true } = {}) => {
    const row = await findSupplier(id);
    const credit = withCredit ? (await creditSummariesFor([row.id])).get(row.id) : null;
    return presentSupplier(row, credit, { withCredit });
};

/**
 * { name, contactName?, email?, phone?, address?, abn?, website?, notes?,
 *   creditLimit?, paymentTermsDays?, creditNotes? } — the credit fields need
 * `canManageCredit` (suppliers.credit.manage); without it they are refused.
 */
export const createSupplier = async (payload = {}, actor, ctx, { canManageCredit = false } = {}) => {
    const fields = contactFields(payload);
    if (touchesCredit(payload) && !canManageCredit) throw httpError(403, "Credit limits and payment terms are maintained by management (suppliers.credit.manage)");
    await assertNameFree(fields.name);
    const codes = (await Supplier.findAll({ attributes: ["code"], raw: true })).map((r) => r.code);
    const row = await Supplier.create({ ...fields, ...creditFields(payload), code: nextCode(CODE_PREFIX, codes), createdById: actor?.id ?? null });
    await recordActivity({ actor, ctx, entityType: "supplier", entityId: row.id, entityLabel: row.name, action: "created" });
    return getSupplier(row.id, { withCredit: canManageCredit });
};

export const updateSupplier = async (id, payload = {}, actor, ctx, { canManageCredit = false, withCredit = false } = {}) => {
    const row = await findSupplier(id);
    const before = { ...row.get({ plain: true }) }; // a copy: without includes Sequelize hands back the live dataValues
    if (touchesCredit(payload) && !canManageCredit) throw httpError(403, "Credit limits and payment terms are maintained by management (suppliers.credit.manage)");
    const updates = { ...contactFields(payload, { partial: true }), ...creditFields(payload) };
    if (!Object.keys(updates).length) throw httpError(400, "No fields provided");
    if (updates.name !== undefined) await assertNameFree(updates.name, row.id);
    await row.update(updates);
    const changes = diff(before, row.get({ plain: true }), Object.keys(updates));
    if (changes)
        await recordActivity({
            actor, ctx, entityType: "supplier", entityId: row.id, entityLabel: row.name,
            action: CREDIT_KEYS.some((key) => changes[key]) ? "credit_updated" : "updated", changes,
        });
    return getSupplier(row.id, { withCredit });
};

/** Management sets the credit details: { creditLimit?, paymentTermsDays?, creditNotes? }. */
export const updateSupplierCredit = async (id, payload = {}, actor, ctx) => {
    if (!touchesCredit(payload)) throw httpError(400, "Provide creditLimit, paymentTermsDays or creditNotes");
    return updateSupplier(id, { creditLimit: payload.creditLimit, paymentTermsDays: payload.paymentTermsDays, creditNotes: payload.creditNotes }, actor, ctx, { canManageCredit: true, withCredit: true });
};

/** A supplier with prices or transactions is deactivated, not deleted. */
export const deleteSupplier = async (id, actor, ctx) => {
    const row = await findSupplier(id);
    const [prices, transactions] = await Promise.all([
        EquipmentSupplierPrice.count({ where: { supplierId: row.id } }),
        db.SupplierTransaction.count({ where: { supplierId: row.id } }),
    ]);
    if (prices || transactions)
        throw httpError(409, `"${row.name}" has ${prices} price${prices === 1 ? "" : "s"} and ${transactions} transaction${transactions === 1 ? "" : "s"} on record — set it inactive instead of deleting it`);
    await row.destroy();
    await recordActivity({ actor, ctx, entityType: "supplier", entityId: row.id, entityLabel: row.name, action: "deleted" });
};
