// In-app notifications: one reusable notify() every part of the app calls,
// plus the reads the inbox needs.
//
// notify() is deliberately the only way rows get created — it resolves who
// should be told (named users and/or every holder of a role in the unit),
// works out the priority (explicit → the unit's override → the event default),
// writes the rows and pushes them to whoever has the app open (SSE).
import { Op } from "sequelize";
import db from "../../../models/index.js";
import { parseId } from "../../../utils/ids.js";
import { publish } from "./notificationStream.js";
import { DEFAULT_PRIORITY, NOTIFICATION_EVENTS, isEventKey, isPriority } from "./notificationEvents.js";

const { Notification, User, UserBusinessUnit, BusinessUnit, Opportunity } = db;

const httpError = (status, message) => Object.assign(new Error(message), { status });

/** Public shape of a notification row. */
export const presentNotification = (row) => {
    const plain = typeof row.get === "function" ? row.get({ plain: true }) : { ...row };
    return {
        id: plain.id,
        event: plain.event,
        priority: plain.priority,
        title: plain.title,
        body: plain.body ?? null,
        read: Boolean(plain.read),
        opportunityId: plain.opportunityId ?? null,
        opportunityNumber: plain.opportunity?.number ?? null,
        createdAt: plain.createdAt,
    };
};

const opportunityInclude = () => [{ model: Opportunity, as: "opportunity", attributes: ["id", "number"] }];

// ---- Recipients -------------------------------------------------------------

/** Active users in a unit holding a role code (roles is a text[] on users). */
const roleHoldersIn = async (businessUnitId, roleCode) => {
    if (!businessUnitId || !roleCode) return [];
    const links = await UserBusinessUnit.findAll({ where: { businessUnitId }, attributes: ["userId"] });
    if (!links.length) return [];
    return User.findAll({
        where: {
            id: { [Op.in]: links.map((link) => link.userId) },
            status: "active",
            roles: { [Op.contains]: [roleCode] },
        },
        attributes: ["id", "name"],
    });
};

const activeUsersByIds = async (ids) => {
    const wanted = [...new Set(ids.map(Number).filter(Boolean))];
    if (!wanted.length) return [];
    return User.findAll({ where: { id: { [Op.in]: wanted }, status: "active" }, attributes: ["id", "name"] });
};

// ---- Priority ---------------------------------------------------------------

/**
 * high | medium | low for this event: what the caller asked for, else the
 * business unit's override, else the event's default.
 */
export const priorityFor = async (event, { priority = null, businessUnitId = null, unit = null } = {}) => {
    if (priority && isPriority(priority)) return priority;
    const record = unit ?? (businessUnitId ? await BusinessUnit.findByPk(businessUnitId, { attributes: ["id", "notificationPriorities"] }) : null);
    const override = record?.notificationPriorities?.[event];
    if (override && isPriority(override)) return override;
    return NOTIFICATION_EVENTS[event]?.priority ?? DEFAULT_PRIORITY;
};

// ---- Raising a notification -------------------------------------------------

/**
 * Raises one notification per recipient. Use it from anywhere:
 *
 *   await notify({
 *       event: "assignment.estimator",       // key from notificationEvents.js
 *       title: `You are the estimator on ${opportunity.number}`,
 *       body: "Prestige Renewable · Bathurst",
 *       userIds: [estimator.id],             // named recipients
 *       roleCode: "SMM",                     // and/or every holder in the unit
 *       opportunity,                         // links the notice to the record
 *       actor,                               // never notifies the person acting
 *       priority: "high",                    // optional; overrides the unit setting
 *       dedupeKey: `sla:${opportunity.id}`,  // optional; at most one per user
 *   });
 *
 * Returns { created, priority, recipients }. No recipients is not an error —
 * a unit may simply have nobody in that role yet.
 */
export const notify = async ({
    event,
    title,
    body = null,
    userIds = [],
    roleCode = null,
    businessUnitId = null,
    opportunity = null,
    priority = null,
    dedupeKey = null,
    actor = null,
    includeActor = false,
} = {}) => {
    if (!isEventKey(event)) throw httpError(500, `Unknown notification event "${event}"`);
    if (!String(title ?? "").trim()) throw httpError(500, "A notification needs a title");

    const unitId = businessUnitId ?? opportunity?.businessUnitId ?? null;
    const [named, holders] = await Promise.all([
        activeUsersByIds(Array.isArray(userIds) ? userIds : [userIds]),
        roleCode ? roleHoldersIn(unitId, roleCode) : [],
    ]);

    const byId = new Map();
    for (const user of [...named, ...holders]) byId.set(user.id, user);
    if (!includeActor && actor?.id) byId.delete(actor.id);
    const recipients = [...byId.values()];

    const level = await priorityFor(event, { priority, businessUnitId: unitId });
    if (!recipients.length) return { created: 0, priority: level, recipients: [] };

    const rows = recipients.map((user) => ({
        userId: user.id,
        opportunityId: opportunity?.id ?? null,
        event,
        priority: level,
        title: String(title).slice(0, 255),
        body: body ? String(body) : null,
        dedupeKey,
    }));

    // With a dedupe key the insert is "at most once per user", so a repeated
    // check (the SLA watcher) adds nothing the second time around. findOrCreate
    // per recipient rather than a bulk insert that ignores conflicts: only that
    // way do we know which rows are genuinely new and worth pushing to the
    // browser. Recipients per notification are few, so the extra round trips
    // are cheap.
    let created = [];
    if (dedupeKey) {
        for (const row of rows) {
            const [record, isNew] = await Notification.findOrCreate({
                where: { userId: row.userId, dedupeKey },
                defaults: row,
            });
            if (isNew) created.push(record);
        }
    } else {
        created = await Notification.bulkCreate(rows, { returning: true });
    }

    for (const row of created)
        publish(row.userId, "notification", { ...presentNotification(row), opportunityNumber: opportunity?.number ?? null });

    return {
        created: created.length,
        priority: level,
        recipients: recipients.map((user) => ({ id: user.id, name: user.name })),
    };
};

// ---- Inbox reads ------------------------------------------------------------

export const unreadCount = (userId) => Notification.count({ where: { userId, read: false } });

/** The signed-in user's notifications, newest first. */
export const listNotifications = async (user, { unread, priority, event, page = 1, pageSize = 30 } = {}) => {
    const where = { userId: user.id };
    if (unread === true || unread === "true" || unread === "1") where.read = false;
    if (priority && isPriority(priority)) where.priority = priority;
    if (event && isEventKey(event)) where.event = event;

    const limit = Math.min(Math.max(Number(pageSize) || 30, 1), 100);
    const current = Math.max(Number(page) || 1, 1);

    const [{ rows, count }, unreadTotal] = await Promise.all([
        Notification.findAndCountAll({
            where,
            include: opportunityInclude(),
            order: [["createdAt", "DESC"], ["id", "DESC"]],
            limit,
            offset: (current - 1) * limit,
        }),
        unreadCount(user.id),
    ]);

    return { rows: rows.map(presentNotification), total: count, page: current, pageSize: limit, unread: unreadTotal };
};

/** Marks one of the caller's notifications read (or unread with read: false). */
export const setRead = async (user, id, read = true) => {
    const row = await Notification.findOne({
        where: { id: parseId(id, "notification id"), userId: user.id },
        include: opportunityInclude(),
    });
    if (!row) throw httpError(404, "Notification not found");
    if (row.read !== read) await row.update({ read });
    return presentNotification(row);
};

export const markAllRead = async (user) => {
    const [updated] = await Notification.update({ read: true }, { where: { userId: user.id, read: false } });
    return { updated };
};
