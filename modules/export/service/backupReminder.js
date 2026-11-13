// Excel backups: when each business unit last had one, and the reminder when
// nobody has taken one for BACKUP_REMINDER_DAYS (default 7).
//
// A *full backup* is a unit export with no stage, lifecycle or date filter —
// every job in the unit (exportService records it in data_exports). A unit
// that has never had one is measured from its first job; a unit with no jobs
// has nothing to back up and is never reminded.
//
// Who is reminded: every active user who holds admin.export — by default the
// superadmin (ADM), the Business Owner (BO) and the SysAdmin (SYS) — and is
// assigned to the unit (ADM covers every unit). Granting or revoking
// admin.export on the roles screen changes who hears, so nobody is asked to
// take a backup they cannot download.
//
// The check runs in the SLA watcher's daily pass. The dedupe key holds the
// date measured from and how many whole reminder periods have gone by, so a
// person hears once when a unit reaches 7 days, again at 14, and so on — not
// every pass. A full backup marks the unit's open reminders read for everyone.

import { Op } from "sequelize";
import db, { sequelize } from "../../../models/index.js";
import { unitScopeOf } from "../../../utils/unitScope.js";
import { unitDate } from "../../../utils/unitTime.js";
import { notify } from "../../notification/service/notificationService.js";
import { roleCodesWithPermission, SUPER_ROLE_CODE } from "../../role/service/roleService.js";

export const EXPORT_PERMISSION = "admin.export";
export const BACKUP_EVENT = "backup.overdue";
const DEFAULT_REMINDER_DAYS = 7;
const DAY_MS = 86400000;
const UNIT_ATTRIBUTES = ["id", "code", "name", "timezone", "status"];

/** BACKUP_REMINDER_DAYS, default 7; 0 turns the reminder off. */
export const reminderDays = () => {
    const raw = process.env.BACKUP_REMINDER_DAYS;
    const days = raw === undefined || raw === "" ? DEFAULT_REMINDER_DAYS : Number(raw);
    return Number.isFinite(days) && days > 0 ? days : 0;
};

/** unit id → { at, userName } of its newest full backup. */
const lastFullBackups = async (unitIds) => {
    const [rows] = await sequelize.query(
        `SELECT DISTINCT ON (e.business_unit_id)
                e.business_unit_id AS "unitId", e.created_at AS "at", u.name AS "userName"
         FROM data_exports e
         LEFT JOIN users u ON u.id = e.user_id
         WHERE e.full_backup AND e.business_unit_id IN (:unitIds)
         ORDER BY e.business_unit_id, e.created_at DESC`,
        { replacements: { unitIds } }
    );
    return new Map(rows.map((row) => [Number(row.unitId), row]));
};

/** unit id → { jobs, first }: how many jobs it has and when the first was created (deleted jobs aside). */
const jobStats = async (unitIds) => {
    const [rows] = await sequelize.query(
        `SELECT business_unit_id AS "unitId", COUNT(*)::int AS "jobs", MIN(created_at) AS "first"
         FROM opportunities
         WHERE deleted_at IS NULL AND business_unit_id IN (:unitIds)
         GROUP BY business_unit_id`,
        { replacements: { unitIds } }
    );
    return new Map(rows.map((row) => [Number(row.unitId), row]));
};

/** Where each unit stands: its last full backup, how long ago, and whether a reminder is due. */
const unitStatuses = async (units, now = new Date()) => {
    if (!units.length) return [];
    const ids = units.map((unit) => unit.id);
    const [backups, jobs] = await Promise.all([lastFullBackups(ids), jobStats(ids)]);
    const days = reminderDays();
    return units.map((unit) => {
        const last = backups.get(unit.id) ?? null;
        const stats = jobs.get(unit.id) ?? { jobs: 0, first: null };
        const since = last ? new Date(last.at) : stats.first ? new Date(stats.first) : null;
        const elapsed = since ? now - since : null;
        return {
            unit,
            jobCount: stats.jobs,
            lastBackup: last ? { at: new Date(last.at), byName: last.userName ?? null } : null,
            since,
            daysSince: elapsed === null ? null : Math.floor(elapsed / DAY_MS),
            due: Boolean(days && stats.jobs && elapsed !== null && elapsed >= days * DAY_MS),
            periods: days && elapsed !== null ? Math.floor(elapsed / (days * DAY_MS)) : 0,
        };
    });
};

const unitsInScope = (actor) => {
    const scope = unitScopeOf(actor);
    const where = scope === null ? { status: { [Op.ne]: "inactive" } } : { id: { [Op.in]: scope.length ? scope : [0] } };
    return db.BusinessUnit.findAll({ where, attributes: UNIT_ATTRIBUTES, order: [["name", "ASC"]] });
};

/** The Data backup screen: each of the caller's units, its last full backup and whether one is due. */
export const backupStatus = async (actor) => {
    const statuses = await unitStatuses(await unitsInScope(actor));
    return {
        reminderDays: reminderDays(),
        units: statuses.map(({ unit, jobCount, lastBackup, daysSince, due }) => ({
            id: unit.id,
            code: unit.code,
            name: unit.name,
            timezone: unit.timezone,
            jobCount,
            lastBackup,
            daysSince,
            due,
        })),
    };
};

/** Active users who may export, with the units they are assigned to. */
const exporters = async () => {
    const roleCodes = await roleCodesWithPermission(EXPORT_PERMISSION);
    const users = await db.User.findAll({
        where: { status: "active", roles: { [Op.overlap]: roleCodes } },
        attributes: ["id", "roles"],
        include: [{ model: db.BusinessUnit, as: "businessUnits", attributes: ["id"], through: { attributes: [] } }],
    });
    return users.map((user) => ({
        id: user.id,
        everyUnit: (user.roles ?? []).includes(SUPER_ROLE_CODE),
        unitIds: new Set((user.businessUnits ?? []).map((unit) => unit.id)),
    }));
};

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
// "Control Centre" is what the app calls the Admin area (prestige-fe SidebarNav).
const WHERE_TO_GO = "Please download the Excel file now: Control Centre → Data backup → Download backup.";

/** One pass: reminds about every unit that has gone BACKUP_REMINDER_DAYS without a full backup. Returns how many notices went out. */
export const runBackupReminderCheck = async (now = new Date()) => {
    if (!reminderDays()) return 0;
    const units = await db.BusinessUnit.findAll({ where: { status: { [Op.ne]: "inactive" } }, attributes: UNIT_ATTRIBUTES });
    const due = (await unitStatuses(units, now)).filter((status) => status.due);
    if (!due.length) return 0;

    const people = await exporters();
    let raised = 0;
    for (const { unit, lastBackup, since, daysSince, periods } of due) {
        const userIds = people.filter((person) => person.everyUnit || person.unitIds.has(unit.id)).map((person) => person.id);
        if (!userIds.length) continue;
        const { created } = await notify({
            event: BACKUP_EVENT,
            title: lastBackup
                ? `You haven't taken a backup of ${unit.name} for ${plural(daysSince, "day")}`
                : `No backup of ${unit.name} has been taken yet`,
            body: lastBackup
                ? `The last full Excel backup was downloaded on ${unitDate(unit, lastBackup.at)}${lastBackup.byName ? ` by ${lastBackup.byName}` : ""}. ${WHERE_TO_GO}`
                : `Its first job was created ${plural(daysSince, "day")} ago and nobody has downloaded a full Excel backup since. ${WHERE_TO_GO}`,
            userIds,
            businessUnitId: unit.id,
            dedupeKey: `backup:${unit.id}:${since.toISOString()}:${periods}`,
        });
        raised += created;
    }
    return raised;
};

/** After a full backup: the unit's open reminders are answered, for everyone who got one. */
export const clearBackupReminders = (businessUnitId) =>
    db.Notification.update(
        { read: true },
        { where: { event: BACKUP_EVENT, read: false, dedupeKey: { [Op.like]: `backup:${Number(businessUnitId)}:%` } } }
    );
