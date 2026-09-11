import db from "../../../models/index.js";

const { CatalogItem } = db;

/** Active catalog items in display order: { key, name, unit, brands: [{ name, unitPrice }] }. */
export const listCatalogItems = async () => {
    const rows = await CatalogItem.findAll({
        where: { isActive: true },
        order: [["sortOrder", "ASC"], ["name", "ASC"]],
    });
    return rows.map((row) => ({
        key: row.key,
        name: row.name,
        unit: row.unit,
        brands: (Array.isArray(row.brands) ? row.brands : []).map((b) => ({
            name: String(b?.name ?? ""),
            unitPrice: Number(b?.unitPrice) || 0,
        })),
    }));
};
