// Job scheduling: jobs on the calendar, routed to the team that does that kind
// of work (installation → crew, delivery → procurement, site inspection →
// operations, maintenance → O&M). Scheduling a job tells the team; naming an
// assignee tells them. The assignee must be on the team (ADM anywhere).
import { Op } from "sequelize";
import db from "../../../models/index.js";
import { parseId } from "../../../utils/ids.js";
import { pagingOf } from "../../../utils/pagination.js";
import { assertUnitAccess, canAccessUnit, unitScopeOf } from "../../../utils/unitScope.js";
import { SUPER_ROLE_CODE } from "../../role/service/roleService.js";
import { recordActivity, diff } from "../../activity/service/activityService.js";
import { notify } from "../../notification/service/notificationService.js";
import { recordSystemEvent } from "../../opportunity/service/leadWorkflowService.js";
import { customerLabel } from "../../opportunity/service/opportunityPeople.js";
import { JOB_TYPES, JOB_STATUSES, TEAMS, TEAM_ROLES, TEAM_LABELS, JOB_TYPE_TEAM, teamForJobType } from "../model/jobSchedule.js";
import { httpError, isBlank, requiredText, optionalText, optionalLongText, oneOf, userBrief } from "../../equipment/service/shared.js";

const { JobSchedule, Opportunity, Project, BusinessUnit, User, UserBusinessUnit } = db;

const INCLUDE = [
    { model: Opportunity, as: "opportunity", attributes: ["id", "number", "businessUnitId", "customerLegalName", "customerTradingName", "siteLine1", "siteSuburb", "siteState", "sitePostcode", "salespersonId"] },
    { model: Project, as: "project", attributes: ["id", "code", "status"] },
    { model: BusinessUnit, as: "businessUnit", attributes: ["id", "code", "name"] },
    { model: User, as: "assignee", attributes: ["id", "name", "roles"] },
    { model: User, as: "createdBy", attributes: ["id", "name"] },
];

const INSTALL_TYPES = ["installation", "electrical", "commissioning"];

const siteOf = (o) => (o ? [o.siteLine1, o.siteSuburb, o.siteState, o.sitePostcode].filter(Boolean).join(", ") : "");
const whenOf = (date) => new Date(date).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short", timeZone: "Australia/Sydney" });

export const presentJob = (row) => ({
    id: row.id,
    title: row.title,
    jobType: row.jobType,
    team: row.team,
    teamLabel: TEAM_LABELS[row.team] ?? row.team,
    status: row.status,
    scheduledStart: row.scheduledStart,
    scheduledEnd: row.scheduledEnd ?? null,
    location: row.location ?? null,
    notes: row.notes ?? null,
    job: row.opportunity ? { id: row.opportunity.id, number: row.opportunity.number, customer: customerLabel(row.opportunity), site: siteOf(row.opportunity) } : null,
    project: row.project ? { id: row.project.id, code: row.project.code, status: row.project.status } : null,
    businessUnit: row.businessUnit ? { id: row.businessUnit.id, code: row.businessUnit.code, name: row.businessUnit.name } : { id: row.businessUnitId },
    assignee: userBrief(row.assignee),
    createdBy: userBrief(row.createdBy),
    completedAt: row.completedAt ?? null,
    overdue: row.status === "scheduled" && new Date(row.scheduledEnd ?? row.scheduledStart) < new Date(),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
});

const dateTime = (value, label, { allowNull = false } = {}) => {
    if (isBlank(value)) {
        if (allowNull) return null;
        throw httpError(400, `${label} is required`);
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw httpError(400, `${label} must be a date/time`);
    return date;
};

const loadJob = async (id, actor) => {
    const row = await JobSchedule.findByPk(parseId(id, "job id"), { include: INCLUDE });
    if (!row || !canAccessUnit(actor, row.businessUnitId)) throw httpError(404, "Job not found");
    return row;
};

/** The assignee must be active, in the unit, and on the team — unless they are ADM. */
const resolveAssignee = async (value, team, businessUnitId) => {
    if (isBlank(value)) return null;
    const user = await User.findByPk(parseId(value, "assigneeId"));
    if (!user || user.status !== "active") throw httpError(400, "The assignee must be an active user");
    if (user.roles.includes(SUPER_ROLE_CODE)) return user;
    const inUnit = await UserBusinessUnit.findOne({ where: { userId: user.id, businessUnitId }, attributes: ["id"] });
    if (!inUnit) throw httpError(400, `${user.name} is not assigned to this business unit`);
    if (!TEAM_ROLES[team].some((code) => user.roles.includes(code)))
        throw httpError(400, `${user.name} is not on the ${TEAM_LABELS[team].toLowerCase()} team (${TEAM_ROLES[team].join(", ")})`);
    return user;
};

/** Notifies every holder of the team's roles in the unit, plus the assignee. */
const tellTeam = async (row, { event, title, body, actor }) => {
    const base = { event, title, body, businessUnitId: row.businessUnitId, opportunity: row.opportunity ?? null, actor, userIds: row.assigneeId ? [row.assigneeId] : [] };
    const recipients = new Map();
    for (const roleCode of TEAM_ROLES[row.team]) {
        const result = await notify({ ...base, roleCode });
        for (const user of result.recipients) recipients.set(user.id, user);
    }
    return [...recipients.values()];
};

// ---- Reads ----------------------------------------------------------------

/** The routing table: which team takes which kind of work. */
export const routing = () => ({
    jobTypes: JOB_TYPES.map((type) => ({ type, team: JOB_TYPE_TEAM[type], teamLabel: TEAM_LABELS[JOB_TYPE_TEAM[type]] })),
    teams: TEAMS.map((team) => ({ team, label: TEAM_LABELS[team], roles: TEAM_ROLES[team] })),
});

/** ?businessUnitId=&team=&jobType=&status=&open=1&assigneeId=&mine=1&opportunityId=&projectId=&from=&to=&page=&pageSize= — soonest first. */
export const listJobs = async (query = {}, actor) => {
    const where = {};
    const scope = unitScopeOf(actor);
    if (!isBlank(query.businessUnitId)) {
        const unitId = parseId(query.businessUnitId, "businessUnitId");
        assertUnitAccess(actor, unitId);
        where.businessUnitId = unitId;
    } else if (scope) where.businessUnitId = { [Op.in]: scope };
    if (query.team) where.team = oneOf(query.team, TEAMS, "team");
    if (query.jobType) where.jobType = oneOf(query.jobType, JOB_TYPES, "jobType");
    if (query.status) where.status = oneOf(query.status, JOB_STATUSES, "status");
    if (query.open === "1" || query.open === "true") where.status = { [Op.in]: ["scheduled", "in_progress"] };
    if (!isBlank(query.assigneeId)) where.assigneeId = parseId(query.assigneeId, "assigneeId");
    if (query.mine === "1" || query.mine === "true") where.assigneeId = actor.id;
    if (!isBlank(query.opportunityId)) where.opportunityId = parseId(query.opportunityId, "opportunityId");
    if (!isBlank(query.projectId)) where.projectId = parseId(query.projectId, "projectId");
    const from = dateTime(query.from, "from", { allowNull: true });
    const to = dateTime(query.to, "to", { allowNull: true });
    if (from || to) where.scheduledStart = { ...(from ? { [Op.gte]: from } : {}), ...(to ? { [Op.lte]: to } : {}) };
    const paging = pagingOf(query, { defaultSize: 25, maxSize: 200 });
    const { rows, count } = await JobSchedule.findAndCountAll({ where, include: INCLUDE, order: [["scheduledStart", "ASC"], ["id", "ASC"]], limit: paging.limit, offset: paging.offset, distinct: true });
    return { data: rows.map(presentJob), total: count, page: paging.page, pageSize: paging.pageSize };
};

export const getJob = async (id, actor) => presentJob(await loadJob(id, actor));

// ---- Writes ---------------------------------------------------------------

/**
 * { businessUnitId?, opportunityId?, projectId?, title, jobType, scheduledStart, scheduledEnd?, assigneeId?, team?, location?, notes? }
 * The team follows from the jobType unless named; the unit from the job when one is given.
 */
export const createJob = async (payload = {}, actor, ctx) => {
    const jobType = oneOf(payload.jobType, JOB_TYPES, "jobType");
    const team = isBlank(payload.team) ? teamForJobType(jobType) : oneOf(payload.team, TEAMS, "team");
    let opportunity = null;
    let project = null;
    if (!isBlank(payload.projectId)) {
        project = await Project.findByPk(parseId(payload.projectId, "projectId"));
        if (!project || !canAccessUnit(actor, project.businessUnitId)) throw httpError(404, "Project not found");
    }
    if (!isBlank(payload.opportunityId) || project) {
        opportunity = await Opportunity.findByPk(project?.opportunityId ?? parseId(payload.opportunityId, "opportunityId"));
        if (!opportunity || !canAccessUnit(actor, opportunity.businessUnitId)) throw httpError(404, "Opportunity not found");
        if (!project) project = await Project.findOne({ where: { opportunityId: opportunity.id } });
    }
    const businessUnitId = opportunity?.businessUnitId ?? (isBlank(payload.businessUnitId) ? null : parseId(payload.businessUnitId, "businessUnitId"));
    if (!businessUnitId) throw httpError(400, "businessUnitId is required when the job is not on an opportunity");
    assertUnitAccess(actor, businessUnitId);
    if (!(await BusinessUnit.findByPk(businessUnitId, { attributes: ["id"] }))) throw httpError(400, "Unknown business unit");
    const scheduledStart = dateTime(payload.scheduledStart, "scheduledStart");
    const scheduledEnd = dateTime(payload.scheduledEnd, "scheduledEnd", { allowNull: true });
    if (scheduledEnd && scheduledEnd < scheduledStart) throw httpError(400, "scheduledEnd must not be before scheduledStart");
    const assignee = await resolveAssignee(payload.assigneeId, team, businessUnitId);

    const row = await JobSchedule.create({
        businessUnitId,
        opportunityId: opportunity?.id ?? null,
        projectId: project?.id ?? null,
        title: requiredText(payload.title, "title", 200),
        jobType,
        team,
        assigneeId: assignee?.id ?? null,
        scheduledStart,
        scheduledEnd,
        location: optionalText(payload.location, "location", 500) || siteOf(opportunity) || null,
        notes: optionalLongText(payload.notes, "notes", 5000),
        createdById: actor?.id ?? null,
    });
    if (project && INSTALL_TYPES.includes(jobType) && project.installationStatus === "not_started")
        await project.update({ installationStatus: "scheduled", status: ["signed", "approvals", "procurement"].includes(project.status) ? "scheduled" : project.status });

    const fresh = await loadJob(row.id, actor);
    const when = whenOf(scheduledStart);
    if (opportunity)
        await recordSystemEvent(opportunity, `Job scheduled: ${row.title} (${jobType.replace("_", " ")}) for ${when} — ${TEAM_LABELS[team]}${assignee ? `, ${assignee.name}` : ""}.`, actor);
    await recordActivity({
        actor, ctx, businessUnitId, entityType: "job_schedule", entityId: row.id, entityLabel: row.title, action: "scheduled",
        meta: { jobType, team, assignee: assignee?.name ?? null, scheduledStart, opportunity: opportunity?.number ?? null },
    });
    await tellTeam(fresh, {
        event: "job.scheduled",
        title: `${TEAM_LABELS[team]}: ${row.title} on ${when}`,
        body: `${opportunity ? `${opportunity.number} · ${customerLabel(opportunity)}` : "No job linked"}${fresh.location ? ` · ${fresh.location}` : ""}${assignee ? ` — assigned to ${assignee.name}` : " — unassigned"}${actor?.name ? `, scheduled by ${actor.name}` : ""}.`,
        actor,
    });
    return presentJob(fresh);
};

/** Any of the create fields (a new jobType re-routes the team unless team is also given), and status. */
export const updateJob = async (id, payload = {}, actor, ctx) => {
    const row = await loadJob(id, actor);
    if (["completed", "cancelled"].includes(row.status) && payload.status === undefined) throw httpError(409, `A ${row.status} job cannot be edited — reopen it first (status: scheduled)`);
    const before = { ...row.get({ plain: true }) }; // a copy: without includes Sequelize hands back the live dataValues
    const updates = {};
    if (payload.title !== undefined) updates.title = requiredText(payload.title, "title", 200);
    if (payload.jobType !== undefined) {
        updates.jobType = oneOf(payload.jobType, JOB_TYPES, "jobType");
        updates.team = isBlank(payload.team) ? teamForJobType(updates.jobType) : oneOf(payload.team, TEAMS, "team");
    } else if (payload.team !== undefined) updates.team = oneOf(payload.team, TEAMS, "team");
    if (payload.scheduledStart !== undefined) updates.scheduledStart = dateTime(payload.scheduledStart, "scheduledStart");
    if (payload.scheduledEnd !== undefined) updates.scheduledEnd = dateTime(payload.scheduledEnd, "scheduledEnd", { allowNull: true });
    const start = updates.scheduledStart ?? row.scheduledStart;
    const end = updates.scheduledEnd === undefined ? row.scheduledEnd : updates.scheduledEnd;
    if (end && new Date(end) < new Date(start)) throw httpError(400, "scheduledEnd must not be before scheduledStart");
    if (payload.location !== undefined) updates.location = optionalText(payload.location, "location", 500);
    if (payload.notes !== undefined) updates.notes = optionalLongText(payload.notes, "notes", 5000);
    const team = updates.team ?? row.team;
    if (payload.assigneeId !== undefined) updates.assigneeId = (await resolveAssignee(payload.assigneeId, team, row.businessUnitId))?.id ?? null;
    else if (updates.team && row.assigneeId) {
        // Re-routed to another team: the assignee goes unless they are on it too.
        try {
            await resolveAssignee(row.assigneeId, team, row.businessUnitId);
        } catch {
            updates.assigneeId = null;
        }
    }
    if (payload.status !== undefined) {
        updates.status = oneOf(payload.status, JOB_STATUSES, "status");
        updates.completedAt = updates.status === "completed" ? new Date() : null;
    }
    if (!Object.keys(updates).length) throw httpError(400, "No fields provided");
    await row.update(updates);
    const fresh = await loadJob(row.id, actor);
    const changes = diff(before, fresh.get({ plain: true }), Object.keys(updates).filter((key) => key !== "completedAt"));
    if (changes) {
        const rescheduled = changes.scheduledStart || changes.scheduledEnd;
        const reassigned = changes.assigneeId;
        await recordActivity({
            actor, ctx, businessUnitId: row.businessUnitId, entityType: "job_schedule", entityId: row.id, entityLabel: fresh.title,
            action: changes.status ? `status_${fresh.status}` : rescheduled ? "rescheduled" : reassigned ? "reassigned" : "updated", changes,
        });
        if (fresh.opportunity) await recordSystemEvent(fresh.opportunity, `Job ${fresh.title}: ${Object.keys(changes).join(", ")} changed.`, actor);
        if (rescheduled || reassigned || changes.status)
            await tellTeam(fresh, {
                event: "job.updated",
                title: `${fresh.title}: ${changes.status ? fresh.status.replace("_", " ") : rescheduled ? "rescheduled" : "reassigned"}`,
                body: `${fresh.opportunity ? `${fresh.opportunity.number} · ` : ""}${whenOf(fresh.scheduledStart)}${fresh.assignee ? ` — ${fresh.assignee.name}` : " — unassigned"}${actor?.name ? `, by ${actor.name}` : ""}.`,
                actor,
            });
    }
    return presentJob(fresh);
};

/** { assigneeId | null } */
export const assignJob = (id, payload = {}, actor, ctx) => updateJob(id, { assigneeId: payload.assigneeId ?? null }, actor, ctx);

/** { status, note? } — completing an installation job moves the project's installation on. */
export const setJobStatus = async (id, payload = {}, actor, ctx) => {
    const status = oneOf(payload.status, JOB_STATUSES, "status");
    const note = optionalLongText(payload.note, "note", 2000);
    const row = await loadJob(id, actor);
    const notes = note ? [row.notes, `${new Date().toISOString().slice(0, 10)} ${actor?.name ?? ""}: ${note}`].filter(Boolean).join("\n").slice(0, 5000) : undefined;
    const result = await updateJob(id, { status, ...(notes ? { notes } : {}) }, actor, ctx);
    if (row.projectId && INSTALL_TYPES.includes(row.jobType) && ["in_progress", "completed"].includes(status)) {
        const project = await Project.findByPk(row.projectId);
        if (project && project.installationStatus !== "completed")
            await project.update({
                installationStatus: "in_progress",
                status: ["signed", "approvals", "procurement", "scheduled"].includes(project.status) ? "installing" : project.status,
            });
    }
    return result;
};

export const deleteJob = async (id, actor, ctx) => {
    const row = await loadJob(id, actor);
    await row.destroy();
    await recordActivity({ actor, ctx, businessUnitId: row.businessUnitId, entityType: "job_schedule", entityId: row.id, entityLabel: row.title, action: "deleted" });
};

/** Dashboard counts for one unit. */
export const jobStats = async (businessUnitId) => {
    const now = new Date();
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart.getTime() + 86400000);
    const weekEnd = new Date(dayStart.getTime() + 7 * 86400000);
    const open = await JobSchedule.findAll({
        where: { businessUnitId, status: { [Op.in]: ["scheduled", "in_progress"] } },
        attributes: ["id", "team", "status", "scheduledStart", "scheduledEnd", "assigneeId"],
        raw: true,
    });
    const byTeam = Object.fromEntries(TEAMS.map((t) => [t, 0]));
    let today = 0;
    let next7 = 0;
    let inProgress = 0;
    let overdue = 0;
    let unassigned = 0;
    for (const job of open) {
        byTeam[job.team] = (byTeam[job.team] ?? 0) + 1;
        const start = new Date(job.scheduledStart);
        if (start >= dayStart && start < dayEnd) today += 1;
        if (start >= dayStart && start < weekEnd) next7 += 1;
        if (job.status === "in_progress") inProgress += 1;
        if (job.status === "scheduled" && new Date(job.scheduledEnd ?? job.scheduledStart) < now) overdue += 1;
        if (!job.assigneeId) unassigned += 1;
    }
    const completed30Days = await JobSchedule.count({ where: { businessUnitId, status: "completed", completedAt: { [Op.gte]: new Date(now.getTime() - 30 * 86400000) } } });
    return { open: open.length, today, next7Days: next7, inProgress, overdue, unassigned, byTeam, completed30Days };
};
