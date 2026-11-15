// Equipment: what the business buys and sells, with supplier prices and the
// margin that turns the purchase price into the sales price.
//
//   cost        the preferred supplier's unit cost, else the lowest on record
//   margin %    the item's own, else EQUIPMENT_DEFAULT_MARGIN_PCT (20)
//   sales price salesPriceOverride when set, else cost × (1 + margin / 100)
//
// Who sees what: everyone signed in reads the sales price list; the purchase
// prices, margins and supplier breakdown are shown only to callers holding
// pricing.cost.read (management and procurement). Writes need equipment.update.
import { Op } from "sequelize";
import db from "../../../models/index.js";
import { parseId } from "../../../utils/ids.js";
import { pagingOf } from "../../../utils/pagination.js";
import { recordActivity, diff } from "../../activity/service/activityService.js";
import { httpError, isBlank, requiredText, optionalText, optionalLongText, money, wholeNumber, dateOnly, round2, userBrief } from "./shared.js";

const { Equipment, EquipmentCategory, EquipmentSupplierPrice, Supplier, User } = db;

export const DEFAULT_MARGIN_PCT = (() => {
    const n = Number(process.env.EQUIPMENT_DEFAULT_MARGIN_PCT);
    return Number.isFinite(n) && n >= 0 ? n : 20;
})();
export const GST_RATE_PCT = 10;
const PRICE_HISTORY_MAX = 20;

const INCLUDE = [
    { model: EquipmentCategory, as: "category", attributes: ["id", "code", "name", "kind", "isActive"] },
    { model: Supplier, as: "preferredSupplier", attributes: ["id", "code", "name"] },
    {
        model: EquipmentSupplierPrice,
        as: "supplierPrices",
        include: [
            { model: Supplier, as: "supplier", attributes: ["id", "code", "name", "isActive", "paymentTermsDays"] },
            { model: User, as: "updatedBy", attributes: ["id", "name"] },
        ],
    },
];

// ---- Pricing ----------------------------------------------------------------

/** The supplier price that counts as the item's cost: the preferred supplier's, else the cheapest current one. */
export const costPriceOf = (item) => {
    const prices = (item.supplierPrices ?? []).filter((p) => p.supplier?.isActive !== false);
    if (!prices.length) return null;
    const preferred = item.preferredSupplierId ? prices.find((p) => p.supplierId === item.preferredSupplierId) : null;
    if (preferred) return preferred;
    return prices.reduce((best, p) => (best === null || Number(p.unitCost) < Number(best.unitCost) ? p : best), null);
};

/** { cost, marginPct, marginAmount, salesPrice, salesPriceIncGst, derived, costSupplier } for an item. */
export const pricingOf = (item) => {
    const costRow = costPriceOf(item);
    const cost = costRow ? round2(costRow.unitCost) : null;
    const marginPct = item.marginPct === null || item.marginPct === undefined ? DEFAULT_MARGIN_PCT : Number(item.marginPct);
    const override = item.salesPriceOverride === null || item.salesPriceOverride === undefined ? null : round2(item.salesPriceOverride);
    const derived = cost === null ? null : round2(cost * (1 + marginPct / 100));
    const salesPrice = override ?? derived;
    const marginAmount = salesPrice !== null && cost !== null ? round2(salesPrice - cost) : null;
    const effectiveMarginPct = salesPrice !== null && cost ? round2(((salesPrice - cost) / cost) * 100) : marginPct;
    return {
        cost,
        costSupplier: costRow?.supplier ? { id: costRow.supplier.id, name: costRow.supplier.name } : null,
        marginPct,
        marginIsDefault: item.marginPct === null || item.marginPct === undefined,
        effectiveMarginPct,
        marginAmount,
        salesPrice,
        salesPriceIncGst: salesPrice === null ? null : round2(salesPrice * (1 + GST_RATE_PCT / 100)),
        salesPriceOverride: override,
        derived: override === null,
    };
};

const presentSupplierPrice = (row) => ({
    id: row.id,
    supplierId: row.supplierId,
    supplier: row.supplier ? { id: row.supplier.id, code: row.supplier.code, name: row.supplier.name, isActive: row.supplier.isActive } : null,
    unitCost: round2(row.unitCost),
    supplierSku: row.supplierSku ?? null,
    leadTimeDays: row.leadTimeDays ?? null,
    minOrderQty: row.minOrderQty ?? null,
    validFrom: row.validFrom ?? null,
    validTo: row.validTo ?? null,
    notes: row.notes ?? null,
    priceHistory: row.priceHistory ?? [],
    updatedBy: userBrief(row.updatedBy),
    updatedAt: row.updatedAt,
});

/**
 * The item as the caller may see it. `showCost` (pricing.cost.read) adds the
 * purchase prices, margins and supplier breakdown; without it the sales price
 * list is all there is.
 */
export const presentEquipment = (item, { showCost = false } = {}) => {
    const pricing = pricingOf(item);
    const base = {
        id: item.id,
        name: item.name,
        sku: item.sku ?? null,
        brand: item.brand ?? null,
        model: item.model ?? null,
        unit: item.unit,
        description: item.description ?? null,
        specifications: item.specifications ?? {},
        category: item.category ? { id: item.category.id, code: item.category.code, name: item.category.name, kind: item.category.kind } : null,
        isActive: item.isActive,
        salesPrice: pricing.salesPrice,
        salesPriceIncGst: pricing.salesPriceIncGst,
        gstRatePct: GST_RATE_PCT,
        priced: pricing.salesPrice !== null,
        supplierCount: (item.supplierPrices ?? []).length,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
    };
    if (!showCost) return base;
    return {
        ...base,
        cost: pricing.cost,
        costSupplier: pricing.costSupplier,
        marginPct: pricing.marginPct,
        marginIsDefault: pricing.marginIsDefault,
        effectiveMarginPct: pricing.effectiveMarginPct,
        marginAmount: pricing.marginAmount,
        salesPriceOverride: pricing.salesPriceOverride,
        preferredSupplier: item.preferredSupplier ? { id: item.preferredSupplier.id, code: item.preferredSupplier.code, name: item.preferredSupplier.name } : null,
        suppliers: (item.supplierPrices ?? [])
            .map(presentSupplierPrice)
            .sort((a, b) => a.unitCost - b.unitCost)
            .map((p) => ({ ...p, isPreferred: p.supplierId === item.preferredSupplierId })),
    };
};

// ---- Reads ----------------------------------------------------------------

const loadItem = async (id) => {
    const row = await Equipment.findByPk(parseId(id, "equipment id"), { include: INCLUDE });
    if (!row) throw httpError(404, "Equipment not found");
    return row;
};

/** ?categoryId=&kind=&supplierId=&search=&includeInactive=&unpriced=&page=&pageSize= */
export const listEquipment = async (query = {}, { showCost = false } = {}) => {
    const where = {};
    if (!(query.includeInactive === "1" || query.includeInactive === "true")) where.isActive = true;
    if (!isBlank(query.categoryId)) where.categoryId = parseId(query.categoryId, "categoryId");
    if (query.search) {
        const term = `%${String(query.search).trim().slice(0, 100)}%`;
        where[Op.or] = [{ name: { [Op.iLike]: term } }, { sku: { [Op.iLike]: term } }, { brand: { [Op.iLike]: term } }, { model: { [Op.iLike]: term } }];
    }
    const include = INCLUDE.map((i) => ({ ...i }));
    if (query.kind) include[0] = { ...include[0], where: { kind: String(query.kind) }, required: true };
    if (!isBlank(query.supplierId)) {
        const supplierId = parseId(query.supplierId, "supplierId");
        const ids = (await EquipmentSupplierPrice.findAll({ where: { supplierId }, attributes: ["equipmentId"], raw: true })).map((r) => r.equipmentId);
        where.id = { [Op.in]: ids };
    }
    const paging = pagingOf(query, { defaultSize: 25, maxSize: 200 });
    const { rows, count } = await Equipment.findAndCountAll({
        where,
        include,
        order: [["name", "ASC"]],
        limit: paging.limit,
        offset: paging.offset,
        distinct: true,
    });
    let data = rows.map((row) => presentEquipment(row, { showCost }));
    if (query.unpriced === "1" || query.unpriced === "true") data = data.filter((item) => !item.priced);
    return { data, total: count, page: paging.page, pageSize: paging.pageSize, defaultMarginPct: showCost ? DEFAULT_MARGIN_PCT : undefined };
};

export const getEquipment = async (id, { showCost = false } = {}) => presentEquipment(await loadItem(id), { showCost });

/** The sales price list: every active item, grouped by category, sales prices only. */
export const priceList = async () => {
    const rows = await Equipment.findAll({ where: { isActive: true }, include: INCLUDE, order: [["name", "ASC"]] });
    const groups = new Map();
    for (const row of rows) {
        const item = presentEquipment(row, { showCost: false });
        const key = item.category?.id ?? 0;
        if (!groups.has(key)) groups.set(key, { category: item.category ?? { id: null, code: null, name: "Uncategorised", kind: "equipment" }, items: [] });
        groups.get(key).items.push(item);
    }
    return { gstRatePct: GST_RATE_PCT, categories: [...groups.values()].sort((a, b) => String(a.category.name).localeCompare(String(b.category.name))) };
};

// ---- Writes ---------------------------------------------------------------

const resolveCategory = async (value) => {
    if (isBlank(value)) return null;
    const category = await EquipmentCategory.findByPk(parseId(value, "categoryId"));
    if (!category) throw httpError(400, "Unknown category");
    if (!category.isActive) throw httpError(400, `Category "${category.name}" is inactive — reactivate it or pick another`);
    return category.id;
};

const resolveSupplier = async (value, label = "supplierId") => {
    const supplier = await Supplier.findByPk(parseId(value, label));
    if (!supplier) throw httpError(400, "Unknown supplier");
    return supplier;
};

const marginValue = (value) => {
    if (isBlank(value)) return null;
    const pct = Number(value);
    if (!Number.isFinite(pct) || pct < 0 || pct > 1000) throw httpError(400, "marginPct must be a percentage between 0 and 1000");
    return round2(pct);
};

const assertSkuFree = async (sku, exceptId = null) => {
    if (!sku) return;
    const clash = await Equipment.findOne({ where: db.sequelize.where(db.sequelize.fn("lower", db.sequelize.col("sku")), sku.toLowerCase()) });
    if (clash && clash.id !== exceptId) throw httpError(409, `SKU "${sku}" is already used by "${clash.name}"`);
};

const specificationsOf = (value) => {
    if (value === undefined) return undefined;
    if (value === null) return {};
    if (typeof value !== "object" || Array.isArray(value)) throw httpError(400, "specifications must be an object");
    return value;
};

const itemFields = async (payload, { partial = false } = {}) => {
    const out = {};
    const has = (key) => !partial || payload[key] !== undefined;
    if (has("name")) out.name = requiredText(payload.name, "name", 200);
    if (has("sku")) out.sku = optionalText(payload.sku, "sku", 60);
    if (has("brand")) out.brand = optionalText(payload.brand, "brand", 120);
    if (has("model")) out.model = optionalText(payload.model, "model", 120);
    if (has("unit")) out.unit = optionalText(payload.unit, "unit", 30) ?? "unit";
    if (has("description")) out.description = optionalLongText(payload.description, "description", 5000);
    if (has("categoryId")) out.categoryId = await resolveCategory(payload.categoryId);
    if (has("specifications") && payload.specifications !== undefined) out.specifications = specificationsOf(payload.specifications);
    if (has("isActive") && payload.isActive !== undefined) out.isActive = Boolean(payload.isActive);
    return out;
};

const ACTIVITY_FIELDS = ["name", "sku", "brand", "model", "unit", "categoryId", "isActive", "marginPct", "salesPriceOverride", "preferredSupplierId"];

/**
 * { name, categoryId?, sku?, brand?, model?, unit?, description?, specifications?,
 *   marginPct?, salesPriceOverride?, preferredSupplierId?,
 *   suppliers?: [{ supplierId, unitCost, leadTimeDays?, … }] }
 */
export const createEquipment = async (payload = {}, actor, ctx) => {
    const fields = await itemFields(payload);
    await assertSkuFree(fields.sku);
    const marginPct = marginValue(payload.marginPct);
    const salesPriceOverride = money(payload.salesPriceOverride, "salesPriceOverride", { allowNull: true });
    const preferred = isBlank(payload.preferredSupplierId) ? null : await resolveSupplier(payload.preferredSupplierId, "preferredSupplierId");
    const row = await Equipment.create({ ...fields, marginPct, salesPriceOverride, preferredSupplierId: preferred?.id ?? null, createdById: actor?.id ?? null, updatedById: actor?.id ?? null });
    if (Array.isArray(payload.suppliers)) for (const entry of payload.suppliers) await upsertSupplierPrice(row, entry, actor, ctx, { quiet: true });
    await recordActivity({ actor, ctx, entityType: "equipment", entityId: row.id, entityLabel: row.name, action: "created", meta: { marginPct, salesPriceOverride, suppliers: Array.isArray(payload.suppliers) ? payload.suppliers.length : 0 } });
    return getEquipment(row.id, { showCost: true });
};

/** Any of the create fields; the supplier list is managed through setSupplierPrice / removeSupplierPrice. */
export const updateEquipment = async (id, payload = {}, actor, ctx) => {
    const row = await loadItem(id);
    const before = { ...row.get({ plain: true }) }; // a copy: without includes Sequelize hands back the live dataValues
    const updates = await itemFields(payload, { partial: true });
    if (payload.marginPct !== undefined) updates.marginPct = marginValue(payload.marginPct);
    if (payload.salesPriceOverride !== undefined) updates.salesPriceOverride = money(payload.salesPriceOverride, "salesPriceOverride", { allowNull: true });
    if (payload.preferredSupplierId !== undefined) {
        if (isBlank(payload.preferredSupplierId)) updates.preferredSupplierId = null;
        else {
            const supplier = await resolveSupplier(payload.preferredSupplierId, "preferredSupplierId");
            if (!(row.supplierPrices ?? []).some((p) => p.supplierId === supplier.id)) throw httpError(400, `${supplier.name} has no price on this item yet — add its price first`);
            updates.preferredSupplierId = supplier.id;
        }
    }
    if (!Object.keys(updates).length) throw httpError(400, "No fields provided");
    if (updates.sku !== undefined) await assertSkuFree(updates.sku, row.id);
    await row.update({ ...updates, updatedById: actor?.id ?? null });
    const changes = diff(before, row.get({ plain: true }), ACTIVITY_FIELDS.filter((k) => k in updates));
    if (changes) {
        const pricing = ["marginPct", "salesPriceOverride", "preferredSupplierId"].some((k) => changes[k]);
        await recordActivity({ actor, ctx, entityType: "equipment", entityId: row.id, entityLabel: row.name, action: pricing ? "pricing_updated" : "updated", changes });
    }
    return getEquipment(row.id, { showCost: true });
};

/** Changes the margin (or the fixed sales price) alone: { marginPct? , salesPriceOverride? } — null resets to the default / derived. */
export const setMargin = async (id, payload = {}, actor, ctx) => {
    if (payload.marginPct === undefined && payload.salesPriceOverride === undefined) throw httpError(400, "Provide marginPct and/or salesPriceOverride");
    return updateEquipment(id, { marginPct: payload.marginPct, salesPriceOverride: payload.salesPriceOverride }, actor, ctx);
};

const upsertSupplierPrice = async (item, payload = {}, actor, ctx, { quiet = false } = {}) => {
    const supplier = await resolveSupplier(payload.supplierId);
    const unitCost = money(payload.unitCost, "unitCost");
    const fields = {
        unitCost,
        supplierSku: optionalText(payload.supplierSku, "supplierSku", 60),
        leadTimeDays: wholeNumber(payload.leadTimeDays, "leadTimeDays", { allowNull: true }),
        minOrderQty: wholeNumber(payload.minOrderQty, "minOrderQty", { allowNull: true, min: 1 }),
        validFrom: dateOnly(payload.validFrom, "validFrom"),
        validTo: dateOnly(payload.validTo, "validTo"),
        notes: optionalText(payload.notes, "notes", 500),
        updatedById: actor?.id ?? null,
    };
    const existing = await EquipmentSupplierPrice.findOne({ where: { equipmentId: item.id, supplierId: supplier.id } });
    const stamp = { unitCost, at: new Date().toISOString(), byId: actor?.id ?? null, byName: actor?.name ?? null };
    let row;
    let previous = null;
    if (existing) {
        previous = round2(existing.unitCost);
        const history = previous !== unitCost ? [stamp, ...(existing.priceHistory ?? [])].slice(0, PRICE_HISTORY_MAX) : existing.priceHistory ?? [];
        // Fields not sent keep their value.
        const partial = Object.fromEntries(Object.entries(fields).filter(([key]) => key === "unitCost" || key === "updatedById" || payload[key] !== undefined));
        row = await existing.update({ ...partial, priceHistory: history });
    } else {
        row = await EquipmentSupplierPrice.create({ equipmentId: item.id, supplierId: supplier.id, ...fields, priceHistory: [stamp] });
        // The first supplier on an item is its preferred one until somebody says otherwise.
        if (!item.preferredSupplierId || payload.isPreferred === true) await item.update({ preferredSupplierId: supplier.id });
    }
    if (payload.isPreferred === true && item.preferredSupplierId !== supplier.id) await item.update({ preferredSupplierId: supplier.id });
    if (!quiet)
        await recordActivity({
            actor, ctx, entityType: "equipment", entityId: item.id, entityLabel: item.name,
            action: existing ? "supplier_price_updated" : "supplier_added",
            changes: existing && previous !== unitCost ? { unitCost: { from: previous, to: unitCost } } : null,
            meta: { supplierId: supplier.id, supplier: supplier.name, unitCost },
        });
    return row;
};

/** Adds a supplier to an item or updates its price: { supplierId, unitCost, supplierSku?, leadTimeDays?, minOrderQty?, validFrom?, validTo?, notes?, isPreferred? }. */
export const setSupplierPrice = async (id, payload = {}, actor, ctx) => {
    const item = await loadItem(id);
    await upsertSupplierPrice(item, payload, actor, ctx);
    return getEquipment(item.id, { showCost: true });
};

export const removeSupplierPrice = async (id, supplierId, actor, ctx) => {
    const item = await loadItem(id);
    const row = await EquipmentSupplierPrice.findOne({ where: { equipmentId: item.id, supplierId: parseId(supplierId, "supplier id") }, include: [{ model: Supplier, as: "supplier", attributes: ["id", "name"] }] });
    if (!row) throw httpError(404, "This supplier has no price on the item");
    await row.destroy();
    if (item.preferredSupplierId === row.supplierId) {
        const next = await EquipmentSupplierPrice.findOne({ where: { equipmentId: item.id }, order: [["unitCost", "ASC"]] });
        await item.update({ preferredSupplierId: next?.supplierId ?? null });
    }
    await recordActivity({ actor, ctx, entityType: "equipment", entityId: item.id, entityLabel: item.name, action: "supplier_removed", meta: { supplierId: row.supplierId, supplier: row.supplier?.name ?? null } });
    return getEquipment(item.id, { showCost: true });
};

export const deleteEquipment = async (id, actor, ctx) => {
    const row = await loadItem(id);
    await row.destroy(); // supplier prices cascade
    await recordActivity({ actor, ctx, entityType: "equipment", entityId: row.id, entityLabel: row.name, action: "deleted" });
};

/** Counts for the dashboard. */
export const equipmentStats = async () => {
    const [items, categories, suppliers] = await Promise.all([
        Equipment.findAll({ where: { isActive: true }, include: INCLUDE }),
        EquipmentCategory.count({ where: { isActive: true } }),
        Supplier.count({ where: { isActive: true } }),
    ]);
    const unpriced = items.filter((item) => pricingOf(item).salesPrice === null).length;
    return { equipmentActive: items.length, unpriced, categoriesActive: categories, suppliersActive: suppliers, defaultMarginPct: DEFAULT_MARGIN_PCT };
};
