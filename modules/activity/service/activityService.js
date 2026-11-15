// The activity log: who made each change, when, and from where.
//
//   await recordActivity({
//       actor: req.user, ctx: req.activity,      // who and from where
//       businessUnitId, entityType: "equipment", entityId: row.id, entityLabel: row.name,
//       action: "updated", changes: diff(before, after), meta: { … },
//   });
//
// Recording never fails the request that caused it: a problem writing the log
// is logged by the server and swallowed, because the change itself has already
// been made and the caller must hear that it succeeded.
import { Op } from "sequelize";
import db from "../../../models/index.js";
import logger from "../../../utils/logger.js";
import { parseId } from "../../../utils/ids.js";
import { oneLine } from "../../../utils/text.js";
import { pagingOf } from "../../../utils/pagination.js";
import { unitScopeOf } from "../../../utils/unitScope.js";
import { ACTIVITY_SOURCES } from "../model/activityLog.js";

const { ActivityLog, User, BusinessUnit } = db;

const httpError = (status, message) => Object.assign(new Error(message), { status });

// Values the log must never keep, whatever field they arrive under.
const SECRET_FIELDS = new Set(["password", "pin", "pinHash", "temporaryPin", "currentPin", "currentPassword", "tokenHash", "token"]);

const plain = (value) => (value && typeof value.get === "function" ? value.get({ plain: true }) : value);

const same = (a, b) => {
    if (a === b) return true;
    if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
    if (a instanceof Date || b instanceof Date) return new Date(a).getTime() === new Date(b).getTime();
    if (typeof a === "object" || typeof b === "object") return JSON.stringify(a) === JSON.stringify(b);
    return String(a) === String(b);
};

/**
 * { field: { from, to } } for the fields that differ. `fields` limits the
 * comparison to those keys (default: every key of `after`); secrets and
 * timestamps are left out.
 */
export const diff = (before = {}, after = {}, fields = null) => {
    const b = plain(before) ?? {};
    const a = plain(after) ?? {};
    const keys = fields ?? Object.keys(a);
    const changes = {};
    for (const key of keys) {
        if (SECRET_FIELDS.has(key) || key === "updatedAt" || key === "createdAt") continue;
        if (!same(b[key], a[key])) changes[key] = { from: b[key] ?? null, to: a[key] ?? null };
    }
    return Object.keys(changes).length ? changes : null;
};

/** Writes one row. Never throws. Returns the row, or null when it could not be written. */
export const recordActivity = async ({
    actor = null,
    ctx = null,
    source = null,
    businessUnitId = null,
    entityType,
    entityId = null,
    entityLabel = null,
    action,
    changes = null,
    meta = null,
} = {}) => {
    try {
        const chosen = source ?? ctx?.source ?? (actor ? "api" : "system");
        return await ActivityLog.create({
            businessUnitId: businessUnitId ? Number(businessUnitId) : null,
            actorId: actor?.id ?? null,
            actorName: actor?.name ?? null,
            source: ACTIVITY_SOURCES.includes(chosen) || /^[a-z][a-z0-9_-]{0,29}$/.test(chosen) ? chosen : "api",
            entityType: oneLine(entityType, 40),
            entityId: entityId === null || entityId === undefined ? null : oneLine(String(entityId), 40),
            entityLabel: entityLabel ? oneLine(entityLabel, 255) : null,
            action: oneLine(action, 60),
            changes: changes && Object.keys(changes).length ? changes : null,
            meta: meta && Object.keys(meta).length ? meta : null,
            ip: ctx?.ip ?? null,
            userAgent: ctx?.userAgent ?? null,
        });
    } catch (err) {
        logger.error(`Activity log write failed (${entityType} ${action}): ${err.message}`);
        return null;
    }
};

export const presentActivity = (row) => {
    const r = plain(row);
    return {
        id: r.id,
        at: r.createdAt,
        source: r.source,
        actor: r.actorId || r.actorName ? { id: r.actorId, name: r.actor?.name ?? r.actorName } : null,
        businessUnit: r.businessUnit ? { id: r.businessUnit.id, code: r.businessUnit.code, name: r.businessUnit.name } : null,
        entityType: r.entityType,
        entityId: r.entityId,
        entityLabel: r.entityLabel,
        action: r.action,
        changes: r.changes,
        meta: r.meta,
        ip: r.ip,
    };
};

const INCLUDE = [
    { model: User, as: "actor", attributes: ["id", "name"] },
    { model: BusinessUnit, as: "businessUnit", attributes: ["id", "code", "name"] },
];

const dateOf = (value, label, endOfDay = false) => {
    if (value === undefined || value === null || value === "") return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw httpError(400, `${label} must be a date`);
    if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(String(value))) date.setUTCHours(23, 59, 59, 999);
    return date;
};

/**
 * ?businessUnitId=&entityType=&entityId=&actorId=&action=&source=&from=&to=&search=&page=&pageSize=
 * Newest first. Rows are unit-scoped like everything else: a caller sees the
 * units they are assigned to (plus rows with no unit — users, equipment —
 * which are shared); ADM sees all.
 */
export const listActivity = async (query = {}, actor) => {
    const where = {};
    const scope = unitScopeOf(actor);
    if (query.businessUnitId) {
        const unitId = parseId(query.businessUnitId, "businessUnitId");
        if (scope && !scope.includes(unitId)) throw httpError(403, "This business unit is outside your assignments");
        where.businessUnitId = unitId;
    } else if (scope) {
        where[Op.or] = [{ businessUnitId: { [Op.in]: scope } }, { businessUnitId: null }];
    }
    if (query.entityType) where.entityType = oneLine(query.entityType, 40);
    if (query.entityId) where.entityId = oneLine(String(query.entityId), 40);
    if (query.actorId) where.actorId = parseId(query.actorId, "actorId");
    if (query.action) where.action = oneLine(query.action, 60);
    if (query.source) where.source = oneLine(query.source, 30);
    const from = dateOf(query.from, "from");
    const to = dateOf(query.to, "to", true);
    if (from || to) where.createdAt = { ...(from ? { [Op.gte]: from } : {}), ...(to ? { [Op.lte]: to } : {}) };
    if (query.search) {
        const term = `%${oneLine(query.search, 100)}%`;
        where[Op.and] = [{ [Op.or]: [{ entityLabel: { [Op.iLike]: term } }, { actorName: { [Op.iLike]: term } }, { action: { [Op.iLike]: term } }] }];
    }
    const paging = pagingOf(query, { defaultSize: 25, maxSize: 200 });
    const { rows, count } = await ActivityLog.findAndCountAll({
        where,
        include: INCLUDE,
        order: [["createdAt", "DESC"], ["id", "DESC"]],
        limit: paging.limit,
        offset: paging.offset,
    });
    return { data: rows.map(presentActivity), total: count, page: paging.page, pageSize: paging.pageSize };
};

/** Everything recorded against one entity, newest first (capped). */
export const activityFor = async (entityType, entityId, { limit = 100 } = {}) => {
    const rows = await ActivityLog.findAll({
        where: { entityType: oneLine(entityType, 40), entityId: oneLine(String(entityId), 40) },
        include: INCLUDE,
        order: [["createdAt", "DESC"], ["id", "DESC"]],
        limit,
    });
    return rows.map(presentActivity);
};

/** The last few changes in a unit, for the dashboard. */
export const recentActivity = async (businessUnitId, limit = 10) => {
    const rows = await ActivityLog.findAll({
        where: { [Op.or]: [{ businessUnitId }, { businessUnitId: null }] },
        include: INCLUDE,
        order: [["createdAt", "DESC"], ["id", "DESC"]],
        limit,
    });
    return rows.map(presentActivity);
};
