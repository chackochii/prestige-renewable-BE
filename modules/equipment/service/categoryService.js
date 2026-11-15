// Equipment and service categories. Category IDs (CAT-001) are the server's
// and permanent; names can change. A category that still has items can be
// deactivated but not removed.
import db from "../../../models/index.js";
import { parseId } from "../../../utils/ids.js";
import { recordActivity, diff } from "../../activity/service/activityService.js";
import { CATEGORY_KINDS } from "../model/equipmentCategory.js";
import { httpError, requiredText, optionalText, oneOf, wholeNumber, nextCode } from "./shared.js";

const { EquipmentCategory, Equipment, sequelize } = db;

const CODE_PREFIX = "CAT-";

const presentCategory = (row, itemCount = 0, activeItemCount = 0) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    kind: row.kind,
    description: row.description ?? null,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    itemCount: Number(itemCount) || 0,
    activeItemCount: Number(activeItemCount) || 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
});

const itemCounts = async (categoryIds) => {
    if (!categoryIds.length) return new Map();
    const rows = await Equipment.findAll({
        attributes: [
            "categoryId",
            [sequelize.fn("COUNT", sequelize.col("id")), "total"],
            [sequelize.fn("SUM", sequelize.literal("CASE WHEN is_active THEN 1 ELSE 0 END")), "active"],
        ],
        where: { categoryId: categoryIds },
        group: ["category_id"],
        raw: true,
    });
    return new Map(rows.map((r) => [Number(r.categoryId), { total: Number(r.total), active: Number(r.active) }]));
};

// Case-insensitive uniqueness per kind, the same rule the index enforces
// (equipment_categories_name_kind_uq), so the clash is a readable 409 rather
// than a database error.
const assertNameFree = async (name, kind, exceptId = null) => {
    const rows = await EquipmentCategory.findAll({
        where: sequelize.and(sequelize.where(sequelize.fn("lower", sequelize.col("name")), name.toLowerCase()), { kind }),
    });
    const other = rows.find((row) => row.id !== exceptId);
    if (other) throw httpError(409, `A ${kind} category named "${other.name}" already exists (${other.code})`);
};

const findCategory = async (id) => {
    const row = await EquipmentCategory.findByPk(parseId(id, "category id"));
    if (!row) throw httpError(404, "Category not found");
    return row;
};

/** Every category with its item counts: ?kind=&includeInactive=1 */
export const listCategories = async ({ kind, includeInactive } = {}) => {
    const where = {};
    if (kind) where.kind = oneOf(kind, CATEGORY_KINDS, "kind");
    if (!(includeInactive === "1" || includeInactive === "true" || includeInactive === true)) where.isActive = true;
    const rows = await EquipmentCategory.findAll({ where, order: [["sortOrder", "ASC"], ["name", "ASC"]] });
    const counts = await itemCounts(rows.map((r) => r.id));
    return rows.map((row) => {
        const c = counts.get(row.id) ?? { total: 0, active: 0 };
        return presentCategory(row, c.total, c.active);
    });
};

export const getCategory = async (id) => {
    const row = await findCategory(id);
    const counts = await itemCounts([row.id]);
    const c = counts.get(row.id) ?? { total: 0, active: 0 };
    return presentCategory(row, c.total, c.active);
};

/** { name, kind?, description?, sortOrder? } */
export const createCategory = async (payload = {}, actor, ctx) => {
    const name = requiredText(payload.name, "name", 120);
    const kind = payload.kind === undefined ? "equipment" : oneOf(payload.kind, CATEGORY_KINDS, "kind");
    await assertNameFree(name, kind);
    const codes = (await EquipmentCategory.findAll({ attributes: ["code"], raw: true })).map((r) => r.code);
    const sortOrder = payload.sortOrder === undefined ? ((await EquipmentCategory.max("sortOrder")) ?? -1) + 1 : wholeNumber(payload.sortOrder, "sortOrder", { min: -1000000 });
    const row = await EquipmentCategory.create({
        code: nextCode(CODE_PREFIX, codes),
        name,
        kind,
        description: optionalText(payload.description, "description", 500),
        isActive: payload.isActive === undefined ? true : Boolean(payload.isActive),
        sortOrder,
    });
    await recordActivity({ actor, ctx, entityType: "equipment_category", entityId: row.id, entityLabel: `${row.code} ${row.name}`, action: "created", meta: { kind } });
    return presentCategory(row);
};

/** Rename, re-describe, re-kind or re-order: any of { name, kind, description, sortOrder, isActive }. */
export const updateCategory = async (id, payload = {}, actor, ctx) => {
    const row = await findCategory(id);
    const before = { ...row.get({ plain: true }) }; // a copy: without includes Sequelize hands back the live dataValues
    const updates = {};
    if (payload.code !== undefined && payload.code !== row.code) throw httpError(400, "Category IDs are permanent");
    if (payload.name !== undefined) updates.name = requiredText(payload.name, "name", 120);
    if (payload.kind !== undefined) updates.kind = oneOf(payload.kind, CATEGORY_KINDS, "kind");
    if (payload.description !== undefined) updates.description = optionalText(payload.description, "description", 500);
    if (payload.sortOrder !== undefined) updates.sortOrder = wholeNumber(payload.sortOrder, "sortOrder", { min: -1000000 });
    if (payload.isActive !== undefined) updates.isActive = Boolean(payload.isActive);
    if (!Object.keys(updates).length) throw httpError(400, "No fields provided. Editable: name, kind, description, sortOrder, isActive");
    if (updates.name !== undefined || updates.kind !== undefined) await assertNameFree(updates.name ?? row.name, updates.kind ?? row.kind, row.id);
    await row.update(updates);
    const changes = diff(before, row.get({ plain: true }), Object.keys(updates));
    if (changes) await recordActivity({ actor, ctx, entityType: "equipment_category", entityId: row.id, entityLabel: `${row.code} ${row.name}`, action: "updated", changes });
    return getCategory(row.id);
};

const setActive = async (id, isActive, actor, ctx) => {
    const row = await findCategory(id);
    if (row.isActive !== isActive) {
        await row.update({ isActive });
        await recordActivity({ actor, ctx, entityType: "equipment_category", entityId: row.id, entityLabel: `${row.code} ${row.name}`, action: isActive ? "reactivated" : "deactivated" });
    }
    return getCategory(row.id);
};

export const deactivateCategory = (id, actor, ctx) => setActive(id, false, actor, ctx);
export const reactivateCategory = (id, actor, ctx) => setActive(id, true, actor, ctx);

/** Removes a category nothing is filed under; one with items answers 409 (deactivate it instead). */
export const deleteCategory = async (id, actor, ctx) => {
    const row = await findCategory(id);
    const items = await Equipment.count({ where: { categoryId: row.id } });
    if (items) throw httpError(409, `"${row.name}" still has ${items} item${items === 1 ? "" : "s"} — move them to another category or deactivate it instead`);
    await row.destroy();
    await recordActivity({ actor, ctx, entityType: "equipment_category", entityId: row.id, entityLabel: `${row.code} ${row.name}`, action: "deleted" });
};
