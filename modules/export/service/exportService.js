// Excel export of job data (admin.export) — a copy of the records people can
// read, filter and keep outside the system, and the business unit's backup.
// Two ways in:
//
//   exportJob(id)      one job, from its page. The route's
//                      requireOpportunityAccess has already checked the unit
//                      and the stage, as for opening the job.
//   exportJobs(query)  every job in a business unit, narrowed by stage,
//                      lifecycle and the day it was created (in the unit's
//                      timezone). admin.export covers every stage — the
//                      people who take the backup (ADM, BO, SYS) do not all
//                      read every stage — so stage read rules do not narrow
//                      it. With no filter at all it is a *full backup*, which
//                      resets the 7-day reminder (backupReminder.js).
//
// Either way the data comes in one query per table for all the jobs at once —
// never a query per job: against the managed database each round trip costs
// about a third of a second. The workbook is laid out by exportWorkbook.js.
//
// Each export is written to the server log and to data_exports (who, which
// unit or job, which filters, how many jobs, full backup or not).

import { literal, Op } from "sequelize";
import db, { sequelize } from "../../../models/index.js";
import { parseId } from "../../../utils/ids.js";
import { unitDate } from "../../../utils/unitTime.js";
import logger from "../../../utils/logger.js";
import storage from "../../../utils/storage.js";
import { isStageNumber, LAST_STAGE, STAGE_LABELS } from "../../opportunity/service/stageAccess.js";
import { buildWorkbook, safeZone } from "./exportWorkbook.js";
import { clearBackupReminders } from "./backupReminder.js";

const httpError = (status, message) => Object.assign(new Error(message), { status });

/** The most jobs one export holds — past this the workbook gets too large to build in memory comfortably. */
export const MAX_EXPORT_JOBS = 5000;
const LIFECYCLES = ["Active", "Won", "Lost", "Closed"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const JOB_INCLUDE = [
    { model: db.Referrer, as: "referrer", attributes: ["id", "organisation"] },
    { model: db.Campaign, as: "campaign", attributes: ["id", "name"] },
];
const UNIT_ATTRIBUTES = ["id", "code", "name", "timezone"];

const plain = (row) => (typeof row?.get === "function" ? row.get({ plain: true }) : row);

/** A stored file's address: the one saved with it, a link kept as-is, or the key's place in the Space. */
const fileLink = ({ storageUrl, key }) => {
    if (storageUrl) return storageUrl;
    if (!key) return null;
    if (/^https?:\/\//i.test(key)) return key;
    try {
        return storage.publicUrl(key);
    } catch {
        return null;
    }
};

/** Everything that hangs off these jobs, one query per table. */
const loadRelated = async (jobs) => {
    const ids = jobs.map((o) => o.id);
    const byJob = { opportunityId: { [Op.in]: ids } };
    const oldestFirst = [["createdAt", "ASC"], ["id", "ASC"]];
    const [users, history, quotes, versions, proposals, requotes, approvals, procurementJobs, purchaseOrders, requests, documents] =
        await Promise.all([
            // Deleted people too: their names still belong on what they did.
            db.User.findAll({ attributes: ["id", "name"], paranoid: false, raw: true }),
            db.OpportunityHistory.findAll({ where: byJob, order: oldestFirst, raw: true }),
            db.Quote.findAll({
                where: byJob,
                include: [
                    { model: db.QuoteItem, as: "items" },
                    { model: db.QuoteCost, as: "additionalCosts" },
                ],
            }),
            db.QuoteVersion.findAll({ where: byJob, order: [["version", "ASC"]], raw: true }),
            db.Proposal.findAll({
                where: byJob,
                include: [{ model: db.QuoteVersion, as: "quoteVersion", attributes: ["id", "version"] }],
                order: [["version", "ASC"]],
            }),
            db.RequoteRequest.findAll({ where: byJob, order: [["round", "ASC"]], raw: true }),
            db.Approval.findAll({ where: byJob, order: [["id", "ASC"]], raw: true }),
            db.ProcurementJob.findAll({ where: byJob, raw: true }),
            db.PurchaseOrder.findAll({ where: byJob, order: oldestFirst, raw: true }),
            db.CollaborationRequest.findAll({
                where: byJob,
                include: [{ model: db.CollaborationAttachment, as: "attachments" }],
                order: oldestFirst,
            }),
            db.Document.findAll({ where: byJob, order: oldestFirst, raw: true }),
        ]);

    const requestRows = requests.map(plain).map((request) => ({
        ...request,
        attachments: (request.attachments ?? [])
            .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt) || a.id - b.id)
            .map((attachment) => ({ ...attachment, link: fileLink({ storageUrl: attachment.storageUrl, key: attachment.storageKey }) })),
    }));
    const requestIds = requestRows.map((request) => request.id);
    const siteVisits = requestIds.length
        ? await db.CollaborationSiteVisit.findAll({ where: { requestId: { [Op.in]: requestIds } }, order: [["id", "ASC"]], raw: true })
        : [];

    return {
        users: new Map(users.map((user) => [user.id, user.name])),
        history,
        quotes: quotes.map(plain),
        versions,
        proposals: proposals.map(plain),
        requotes,
        approvals,
        procurementJobs,
        purchaseOrders,
        requests: requestRows,
        siteVisits,
        documents: documents.map((doc) => ({ ...doc, link: fileLink({ storageUrl: doc.storageUrl, key: doc.url }) })),
    };
};

/** Letters, digits, dot, dash and underscore only — it goes into a Content-Disposition header. */
const fileName = (stem) => `${String(stem).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-")}.xlsx`;

/**
 * Writes the workbook out, then records the download — only once the file
 * exists, so a failed build is not mistaken for a backup. A failure to record
 * is logged, not fatal: the person already has permission to the data.
 */
const finish = async (workbook, filename, actor, record) => {
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    logger.info(`Excel export by user ${actor?.id}: ${JSON.stringify({ ...record, filename })}`);
    try {
        await db.DataExport.create({ ...record, userId: actor?.id ?? null });
        if (record.fullBackup) await clearBackupReminders(record.businessUnitId);
    } catch (err) {
        logger.error(`Could not record the Excel export ${filename}: ${err.message}`);
    }
    return { buffer, filename };
};

// ---- One job ----------------------------------------------------------------

/** → { buffer, filename } for one job. Access is the route's (requireOpportunityAccess). */
export const exportJob = async (id, actor) => {
    const job = await db.Opportunity.findByPk(parseId(id, "opportunity id"), { include: JOB_INCLUDE });
    if (!job) throw httpError(404, "Opportunity not found");
    const [unit, related] = await Promise.all([
        db.BusinessUnit.findByPk(job.businessUnitId, { attributes: UNIT_ATTRIBUTES }),
        loadRelated([job]),
    ]);
    const timeZone = safeZone(unit?.timezone);
    const exportedAt = new Date();
    const workbook = buildWorkbook({
        mode: "job",
        unit,
        timeZone,
        exportedAt,
        actorName: actor?.name ?? null,
        filters: [{ label: "Job", value: job.number }],
        jobs: [plain(job)],
        ...related,
    });

    return finish(workbook, fileName(`${job.number}-${unitDate(timeZone, exportedAt)}`), actor, {
        businessUnitId: job.businessUnitId,
        opportunityId: job.id,
        scope: "job",
        fullBackup: false,
        jobCount: 1,
        filters: { job: job.number },
    });
};

// ---- A business unit's jobs -------------------------------------------------

const dateParam = (value, label) => {
    if (value === undefined || value === null || value === "") return null;
    const text = String(value);
    if (!DATE_RE.test(text) || Number.isNaN(new Date(`${text}T00:00:00Z`).getTime()))
        throw httpError(400, `${label} must be a date (YYYY-MM-DD)`);
    return text;
};

/**
 * query: { businessUnitId, stage?, lifecycle? (Active | Won | Lost | Closed | all),
 * from?, to? (YYYY-MM-DD, the day the job was created where the unit is) }
 * → { buffer, filename }. The route has checked the caller's unit.
 */
export const exportJobs = async (query = {}, actor) => {
    const businessUnitId = parseId(query.businessUnitId, "business unit id");
    const unit = await db.BusinessUnit.findByPk(businessUnitId, { attributes: UNIT_ATTRIBUTES });
    if (!unit) throw httpError(404, "Business unit not found");
    const timeZone = safeZone(unit.timezone);
    const where = { businessUnitId };
    const filters = [];

    // Every stage: admin.export is the backup permission (see the top of the file).
    const stage = query.stage !== undefined && query.stage !== null && query.stage !== "" ? Number(query.stage) : null;
    if (stage !== null) {
        if (!isStageNumber(stage)) throw httpError(400, `stage must be 1–${LAST_STAGE}`);
        where.stage = stage;
    }
    filters.push({ label: "Stage", value: stage === null ? "All stages" : `${stage} · ${STAGE_LABELS[stage]}` });

    const lifecycle = query.lifecycle && query.lifecycle !== "all" ? String(query.lifecycle) : null;
    if (lifecycle && !LIFECYCLES.includes(lifecycle)) throw httpError(400, `lifecycle must be one of: ${LIFECYCLES.join(", ")}, all`);
    if (lifecycle) where.lifecycle = lifecycle;
    filters.push({ label: "Lifecycle", value: lifecycle ?? "All" });

    // The day a job was created is the unit's day, not UTC's: midnight where
    // the unit is, worked out by Postgres from the zone name.
    const from = dateParam(query.from, "from");
    const to = dateParam(query.to, "to");
    if (from && to && from > to) throw httpError(400, "The start date is after the end date");
    const zone = sequelize.escape(timeZone);
    const created = [];
    if (from) created.push(literal(`"Opportunity"."created_at" >= (${sequelize.escape(from)}::date)::timestamp AT TIME ZONE ${zone}`));
    if (to) created.push(literal(`"Opportunity"."created_at" < ((${sequelize.escape(to)}::date + 1)::timestamp AT TIME ZONE ${zone})`));
    if (created.length) where[Op.and] = created;
    filters.push({ label: "Created from", value: from, type: "date" }, { label: "Created to", value: to, type: "date" });

    const found = await db.Opportunity.findAll({
        where,
        include: JOB_INCLUDE,
        order: [["createdAt", "DESC"], ["id", "DESC"]],
        limit: MAX_EXPORT_JOBS + 1,
    });
    if (!found.length) throw httpError(404, "No jobs match these filters");
    if (found.length > MAX_EXPORT_JOBS)
        throw httpError(
            400,
            `More than ${MAX_EXPORT_JOBS.toLocaleString("en-AU")} jobs match. Choose a stage or a shorter date range and export in parts.`
        );

    // No filter at all: every job in the unit — the backup the reminder asks for.
    const fullBackup = stage === null && !lifecycle && !from && !to;
    filters.push({ label: "Full backup", value: fullBackup ? "Yes — every job in the business unit" : "No — filtered export" });

    const jobs = found.map(plain);
    const exportedAt = new Date();
    const workbook = buildWorkbook({
        mode: "unit",
        unit,
        timeZone,
        exportedAt,
        actorName: actor?.name ?? null,
        filters,
        jobs,
        ...(await loadRelated(jobs)),
    });

    const stem = fullBackup ? `${unit.code}-backup` : `${unit.code}-jobs${stage === null ? "" : `-stage-${stage}`}`;
    return finish(workbook, fileName(`${stem}-${unitDate(timeZone, exportedAt)}`), actor, {
        businessUnitId,
        opportunityId: null,
        scope: "unit",
        fullBackup,
        jobCount: jobs.length,
        filters: { stage, lifecycle: lifecycle ?? "all", from, to },
    });
};
