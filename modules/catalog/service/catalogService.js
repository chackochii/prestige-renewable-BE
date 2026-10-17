// Product catalog for the quote builder: items, their brands and unit prices
// (AUD ex GST). The quote builder reads the active items; the system
// administrator maintains the list under Superadmin → Quote catalog.
//
// A quote line copies the item's key and name, the brand and the price when it
// is added, so editing or removing a catalog item never changes a saved quote.
// Keys are permanent: quote lines and the approvals' system summary refer to
// items by key.
import db from "../../../models/index.js";
import { parseId } from "../../../utils/ids.js";

const { CatalogItem } = db;

const httpError = (status, message) => Object.assign(new Error(message), { status });

// The approvals forms read the system off these items (approvalsService
// systemFromItems) — they can be retired, but not deleted.
const SYSTEM_KEYS = ["solar_panel", "string_inverter", "hybrid_inverter", "battery"];

const KEY_MAX = 100;
const NAME_MAX = 255;
const UNIT_MAX = 30;
const BRAND_MAX = 255; // QuoteItem.brand

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

const brandsOf = (row) =>
    (Array.isArray(row.brands) ? row.brands : []).map((b) => ({
        name: String(b?.name ?? ""),
        unitPrice: Number(b?.unitPrice) || 0,
    }));

/** What the quote builder needs: { key, name, unit, brands }. */
const toQuoteDto = (row) => ({ key: row.key, name: row.name, unit: row.unit, brands: brandsOf(row) });

/** What the admin screen needs: the quote shape plus id, status, order and whether it can be deleted. */
const toAdminDto = (row) => ({
    id: row.id,
    ...toQuoteDto(row),
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    isSystem: SYSTEM_KEYS.includes(row.key),
});

const cleanName = (value) => {
    if (typeof value !== "string" || !value.trim()) throw httpError(400, "name is required");
    const name = value.trim();
    if (name.length > NAME_MAX) throw httpError(400, `name must be at most ${NAME_MAX} characters`);
    return name;
};

const cleanUnit = (value) => {
    if (value === null || value === undefined) return "unit";
    if (typeof value !== "string" && typeof value !== "number") throw httpError(400, "unit must be text");
    const unit = String(value).trim();
    if (unit.length > UNIT_MAX) throw httpError(400, `unit must be at most ${UNIT_MAX} characters`);
    return unit || "unit";
};

const cleanSortOrder = (value) => {
    const order = Number(value);
    if (!Number.isInteger(order)) throw httpError(400, "sortOrder must be a whole number");
    return order;
};

// Every item needs at least one brand — the quote builder will not add a line
// without one. Brand names are unique within the item, ignoring case.
const cleanBrands = (value) => {
    if (!Array.isArray(value) || value.length === 0)
        throw httpError(400, "brands must be a non-empty array of { name, unitPrice }");
    const seen = new Set();
    return value.map((brand, index) => {
        if (!isPlainObject(brand)) throw httpError(400, `Brand ${index + 1} must be { name, unitPrice }`);
        const name = typeof brand.name === "string" ? brand.name.trim() : "";
        if (!name) throw httpError(400, `Brand ${index + 1} needs a name`);
        if (name.length > BRAND_MAX) throw httpError(400, `Brand "${name.slice(0, 40)}…" exceeds ${BRAND_MAX} characters`);
        const lower = name.toLowerCase();
        if (seen.has(lower)) throw httpError(400, `Brand "${name}" is listed twice`);
        seen.add(lower);
        const unitPrice = Number(brand.unitPrice);
        if (brand.unitPrice === "" || brand.unitPrice === null || !Number.isFinite(unitPrice) || unitPrice < 0)
            throw httpError(400, `Brand "${name}" needs a unit price of 0 or more`);
        return { name, unitPrice: Math.round(unitPrice * 100) / 100 };
    });
};

const slugify = (text) =>
    text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, KEY_MAX - 4) || "item";

// A key from the name ("Solar panel" → solar_panel), numbered if taken.
const freeKeyFor = async (name) => {
    const base = slugify(name);
    const taken = new Set((await CatalogItem.findAll({ attributes: ["key"] })).map((row) => row.key));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n += 1) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
};

const findItem = async (id) => {
    const row = await CatalogItem.findByPk(parseId(id, "catalog item id"));
    if (!row) throw httpError(404, "Catalog item not found");
    return row;
};

/** Active catalog items in display order: { key, name, unit, brands: [{ name, unitPrice }] }. */
export const listCatalogItems = async () => {
    const rows = await CatalogItem.findAll({
        where: { isActive: true },
        order: [["sortOrder", "ASC"], ["name", "ASC"]],
    });
    return rows.map(toQuoteDto);
};

/** Every catalog item, active and retired, for the admin screen. */
export const listAllCatalogItems = async () => {
    const rows = await CatalogItem.findAll({ order: [["sortOrder", "ASC"], ["name", "ASC"]] });
    return rows.map(toAdminDto);
};

/** payload: { name, unit?, brands, isActive?, sortOrder? } — the key is made from the name. */
export const createCatalogItem = async (payload = {}) => {
    const name = cleanName(payload.name);
    const brands = cleanBrands(payload.brands);
    const sortOrder =
        payload.sortOrder !== undefined && payload.sortOrder !== ""
            ? cleanSortOrder(payload.sortOrder)
            : ((await CatalogItem.max("sortOrder")) ?? -1) + 1;
    const row = await CatalogItem.create({
        key: await freeKeyFor(name),
        name,
        unit: cleanUnit(payload.unit),
        brands,
        isActive: payload.isActive === undefined ? true : Boolean(payload.isActive),
        sortOrder,
    });
    return toAdminDto(row);
};

/** payload: any of { name, unit, brands, isActive, sortOrder }. Keys cannot change. */
export const updateCatalogItem = async (id, payload = {}) => {
    const row = await findItem(id);
    if (payload.key !== undefined && payload.key !== row.key) throw httpError(400, "Catalog item keys are permanent");
    const updates = {};
    if (payload.name !== undefined) updates.name = cleanName(payload.name);
    if (payload.unit !== undefined) updates.unit = cleanUnit(payload.unit);
    if (payload.brands !== undefined) updates.brands = cleanBrands(payload.brands);
    if (payload.isActive !== undefined) updates.isActive = Boolean(payload.isActive);
    if (payload.sortOrder !== undefined) updates.sortOrder = cleanSortOrder(payload.sortOrder);
    if (Object.keys(updates).length === 0)
        throw httpError(400, "No fields provided. Editable: name, unit, brands, isActive, sortOrder");
    await row.update(updates);
    return toAdminDto(row);
};

export const deleteCatalogItem = async (id) => {
    const row = await findItem(id);
    if (SYSTEM_KEYS.includes(row.key))
        throw httpError(409, `"${row.name}" feeds the approvals' system summary — set it to inactive instead of deleting it`);
    await row.destroy();
};
