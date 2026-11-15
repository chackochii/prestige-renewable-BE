// Completed installations: the customer, the date, the job it was, the signed
// quote it delivered, how the customer pays and whether it has been invoiced.
// Recording one completes the project's installation (100 %) and the job
// schedule entry it came from, and tells finance it can be invoiced.
import { Op } from "sequelize";
import db from "../../../models/index.js";
import { parseId } from "../../../utils/ids.js";
import { pagingOf } from "../../../utils/pagination.js";
import { assertUnitAccess, canAccessUnit, unitScopeOf } from "../../../utils/unitScope.js";
import { recordActivity, diff } from "../../activity/service/activityService.js";
import { notify } from "../../notification/service/notificationService.js";
import { recordSystemEvent } from "../../opportunity/service/leadWorkflowService.js";
import { assignedUserIds, customerLabel } from "../../opportunity/service/opportunityPeople.js";
import { PAYMENT_METHODS, INVOICE_STATUSES } from "../model/installation.js";
import { httpError, isBlank, optionalText, optionalLongText, oneOf, dateOnly, today, userBrief } from "../../equipment/service/shared.js";

const { Installation, Opportunity, Project, JobSchedule, QuoteVersion, Proposal, BusinessUnit, User } = db;

const INCLUDE = [
    {
        model: Opportunity,
        as: "opportunity",
        attributes: ["id", "number", "businessUnitId", "customerLegalName", "customerTradingName", "customerEmail", "customerPhone", "siteLine1", "siteSuburb", "siteState", "sitePostcode", "salespersonId", "leadOwnerId", "estimatorId", "operationalCoordinatorId", "deliveryOwnerId"],
    },
    { model: BusinessUnit, as: "businessUnit", attributes: ["id", "code", "name"] },
    { model: Project, as: "project", attributes: ["id", "code", "status", "paymentType"] },
    { model: JobSchedule, as: "jobSchedule", attributes: ["id", "title", "jobType", "scheduledStart"] },
    { model: User, as: "installer", attributes: ["id", "name"] },
    { model: User, as: "completedBy", attributes: ["id", "name"] },
    { model: QuoteVersion, as: "signedQuoteVersion", attributes: ["id", "version", "quoteNumber", "grandTotal", "snapshot"] },
];

const siteOf = (o) => (o ? [o.siteLine1, o.siteSuburb, o.siteState, o.sitePostcode].filter(Boolean).join(", ") : "");

/** What was installed, off the signed quote's items: [{ item, brand, quantity }]. */
const systemFromSnapshot = (snapshot) => {
    const items = snapshot?.items ?? snapshot?.quote?.items ?? [];
    return Array.isArray(items)
        ? items.slice(0, 50).map((i) => ({ item: i.itemName ?? i.name ?? i.itemKey ?? null, brand: i.brand ?? null, quantity: Number(i.quantity) || null }))
        : [];
};

export const presentInstallation = (row) => ({
    id: row.id,
    installationDate: row.installationDate,
    customer: row.opportunity
        ? { name: customerLabel(row.opportunity), email: row.opportunity.customerEmail ?? null, phone: row.opportunity.customerPhone ?? null, site: siteOf(row.opportunity) }
        : null,
    job: row.opportunity ? { id: row.opportunity.id, number: row.opportunity.number } : { id: row.opportunityId },
    jobSchedule: row.jobSchedule ? { id: row.jobSchedule.id, title: row.jobSchedule.title, jobType: row.jobSchedule.jobType, scheduledStart: row.jobSchedule.scheduledStart } : null,
    jobDescription: row.jobDescription ?? null,
    project: row.project ? { id: row.project.id, code: row.project.code, status: row.project.status } : null,
    businessUnit: row.businessUnit ? { id: row.businessUnit.id, code: row.businessUnit.code, name: row.businessUnit.name } : { id: row.businessUnitId },
    installer: userBrief(row.installer),
    signedQuote: row.signedQuoteVersion
        ? { id: row.signedQuoteVersion.id, version: row.signedQuoteVersion.version, quoteNumber: row.signedQuoteVersion.quoteNumber, grandTotal: row.signedQuoteVersion.grandTotal === null ? null : Number(row.signedQuoteVersion.grandTotal) }
        : null,
    systemSummary: row.systemSummary ?? {},
    paymentMethod: row.paymentMethod,
    invoiceStatus: row.invoiceStatus,
    invoiceNumber: row.invoiceNumber ?? null,
    notes: row.notes ?? null,
    completedBy: userBrief(row.completedBy),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
});

const loadInstallation = async (id, actor) => {
    const row = await Installation.findByPk(parseId(id, "installation id"), { include: INCLUDE });
    if (!row || !canAccessUnit(actor, row.businessUnitId)) throw httpError(404, "Installation not found");
    return row;
};

// ---- Reads ----------------------------------------------------------------

/** ?businessUnitId=&invoiceStatus=&paymentMethod=&opportunityId=&from=&to=&search=&page=&pageSize= — newest first. */
export const listInstallations = async (query = {}, actor) => {
    const where = {};
    const scope = unitScopeOf(actor);
    if (!isBlank(query.businessUnitId)) {
        const unitId = parseId(query.businessUnitId, "businessUnitId");
        assertUnitAccess(actor, unitId);
        where.businessUnitId = unitId;
    } else if (scope) where.businessUnitId = { [Op.in]: scope };
    if (!isBlank(query.opportunityId)) where.opportunityId = parseId(query.opportunityId, "opportunityId");
    if (query.paymentMethod) where.paymentMethod = oneOf(query.paymentMethod, PAYMENT_METHODS, "paymentMethod");
    const countWhere = { ...where };
    if (query.invoiceStatus) where.invoiceStatus = oneOf(query.invoiceStatus, INVOICE_STATUSES, "invoiceStatus");
    const from = dateOnly(query.from, "from");
    const to = dateOnly(query.to, "to");
    if (from || to) where.installationDate = { ...(from ? { [Op.gte]: from } : {}), ...(to ? { [Op.lte]: to } : {}) };
    if (query.search) {
        const term = `%${String(query.search).trim().slice(0, 100)}%`;
        where[Op.or] = [
            { invoiceNumber: { [Op.iLike]: term } },
            { "$opportunity.number$": { [Op.iLike]: term } },
            { "$opportunity.customer_legal_name$": { [Op.iLike]: term } },
            { "$opportunity.site_suburb$": { [Op.iLike]: term } },
        ];
    }
    const paging = pagingOf(query, { defaultSize: 12, maxSize: 100 });
    const { rows, count } = await Installation.findAndCountAll({
        where, include: INCLUDE, order: [["installationDate", "DESC"], ["id", "DESC"]], limit: paging.limit, offset: paging.offset, subQuery: false, distinct: true,
    });
    const all = await Installation.findAll({ where: countWhere, attributes: ["invoiceStatus"], raw: true });
    const counts = Object.fromEntries(INVOICE_STATUSES.map((s) => [s, all.filter((r) => r.invoiceStatus === s).length]));
    return { data: rows.map(presentInstallation), total: count, page: paging.page, pageSize: paging.pageSize, counts: { all: all.length, ...counts } };
};

export const getInstallation = async (id, actor) => presentInstallation(await loadInstallation(id, actor));

// ---- Writes ---------------------------------------------------------------

/**
 * { opportunityId, installationDate?, jobDescription?, installerId?, jobScheduleId?,
 *   signedQuoteVersionId?, paymentMethod?, invoiceStatus?, invoiceNumber?, notes? }
 * The signed quote defaults to the accepted proposal's version; the payment
 * method to the project's payment type.
 */
export const recordInstallation = async (payload = {}, actor, ctx) => {
    const opportunity = await Opportunity.findByPk(parseId(payload.opportunityId, "opportunityId"));
    if (!opportunity || !canAccessUnit(actor, opportunity.businessUnitId)) throw httpError(404, "Opportunity not found");
    const project = await Project.findOne({ where: { opportunityId: opportunity.id } });

    let jobSchedule = null;
    if (!isBlank(payload.jobScheduleId)) {
        jobSchedule = await JobSchedule.findByPk(parseId(payload.jobScheduleId, "jobScheduleId"));
        if (!jobSchedule || jobSchedule.opportunityId !== opportunity.id) throw httpError(400, "That scheduled job is not this job's");
    }
    let signedQuoteVersionId = null;
    if (!isBlank(payload.signedQuoteVersionId)) {
        const version = await QuoteVersion.findOne({ where: { id: parseId(payload.signedQuoteVersionId, "signedQuoteVersionId"), opportunityId: opportunity.id } });
        if (!version) throw httpError(400, "That quote version does not belong to this job");
        signedQuoteVersionId = version.id;
    } else {
        const accepted = await Proposal.findOne({ where: { opportunityId: opportunity.id, status: "accepted" }, order: [["acceptedAt", "DESC"]] });
        signedQuoteVersionId = accepted?.quoteVersionId ?? null;
    }
    const signed = signedQuoteVersionId ? await QuoteVersion.findByPk(signedQuoteVersionId, { attributes: ["id", "snapshot"] }) : null;
    let installerId = null;
    if (!isBlank(payload.installerId)) {
        const installer = await User.findByPk(parseId(payload.installerId, "installerId"), { attributes: ["id", "status"] });
        if (!installer || installer.status !== "active") throw httpError(400, "installerId must be an active user");
        installerId = installer.id;
    } else installerId = jobSchedule?.assigneeId ?? null;

    const row = await Installation.create({
        opportunityId: opportunity.id,
        businessUnitId: opportunity.businessUnitId,
        projectId: project?.id ?? null,
        jobScheduleId: jobSchedule?.id ?? null,
        installationDate: dateOnly(payload.installationDate, "installationDate") ?? today(),
        jobDescription: optionalText(payload.jobDescription, "jobDescription", 2000) ?? jobSchedule?.title ?? null,
        installerId,
        signedQuoteVersionId,
        systemSummary: { items: systemFromSnapshot(signed?.snapshot) },
        paymentMethod: isBlank(payload.paymentMethod) ? (project?.paymentType === "loan" ? "loan" : "cash") : oneOf(payload.paymentMethod, PAYMENT_METHODS, "paymentMethod"),
        invoiceStatus: isBlank(payload.invoiceStatus) ? "not_invoiced" : oneOf(payload.invoiceStatus, INVOICE_STATUSES, "invoiceStatus"),
        invoiceNumber: optionalText(payload.invoiceNumber, "invoiceNumber", 60),
        notes: optionalLongText(payload.notes, "notes", 5000),
        completedById: actor?.id ?? null,
    });

    if (jobSchedule && jobSchedule.status !== "completed") await jobSchedule.update({ status: "completed", completedAt: new Date() });
    if (project) await project.update({ installationStatus: "completed", installationProgressPct: 100, status: ["invoiced", "completed", "cancelled"].includes(project.status) ? project.status : "installed" });

    await recordSystemEvent(opportunity, `Installation completed on ${row.installationDate}${row.jobDescription ? ` — ${row.jobDescription}` : ""} (payment: ${row.paymentMethod}, invoice: ${row.invoiceStatus.replace("_", " ")}).`, actor);
    await recordActivity({
        actor, ctx, businessUnitId: row.businessUnitId, entityType: "installation", entityId: row.id, entityLabel: opportunity.number, action: "completed",
        meta: { installationDate: row.installationDate, paymentMethod: row.paymentMethod, invoiceStatus: row.invoiceStatus, project: project?.code ?? null },
    });
    await notify({
        event: "installation.completed",
        title: `${opportunity.number}: installation completed`,
        body: `${customerLabel(opportunity)} — installed ${row.installationDate}${row.invoiceStatus === "not_invoiced" ? ", ready to invoice" : ""}.`,
        userIds: assignedUserIds(opportunity),
        roleCode: "FIN",
        opportunity,
        actor,
    });
    return getInstallation(row.id, actor);
};

/** Any of { installationDate, jobDescription, installerId, paymentMethod, invoiceStatus, invoiceNumber, notes, signedQuoteVersionId }. */
export const updateInstallation = async (id, payload = {}, actor, ctx) => {
    const row = await loadInstallation(id, actor);
    const before = { ...row.get({ plain: true }) }; // a copy: without includes Sequelize hands back the live dataValues
    const updates = {};
    if (payload.installationDate !== undefined) updates.installationDate = dateOnly(payload.installationDate, "installationDate", { allowNull: false });
    if (payload.jobDescription !== undefined) updates.jobDescription = optionalText(payload.jobDescription, "jobDescription", 2000);
    if (payload.installerId !== undefined) {
        if (isBlank(payload.installerId)) updates.installerId = null;
        else {
            const installer = await User.findByPk(parseId(payload.installerId, "installerId"), { attributes: ["id", "status"] });
            if (!installer || installer.status !== "active") throw httpError(400, "installerId must be an active user");
            updates.installerId = installer.id;
        }
    }
    if (payload.signedQuoteVersionId !== undefined) {
        if (isBlank(payload.signedQuoteVersionId)) updates.signedQuoteVersionId = null;
        else {
            const version = await QuoteVersion.findOne({ where: { id: parseId(payload.signedQuoteVersionId, "signedQuoteVersionId"), opportunityId: row.opportunityId } });
            if (!version) throw httpError(400, "That quote version does not belong to this job");
            updates.signedQuoteVersionId = version.id;
            updates.systemSummary = { items: systemFromSnapshot(version.snapshot) };
        }
    }
    if (payload.paymentMethod !== undefined) updates.paymentMethod = oneOf(payload.paymentMethod, PAYMENT_METHODS, "paymentMethod");
    if (payload.invoiceStatus !== undefined) updates.invoiceStatus = oneOf(payload.invoiceStatus, INVOICE_STATUSES, "invoiceStatus");
    if (payload.invoiceNumber !== undefined) updates.invoiceNumber = optionalText(payload.invoiceNumber, "invoiceNumber", 60);
    if (payload.notes !== undefined) updates.notes = optionalLongText(payload.notes, "notes", 5000);
    if (!Object.keys(updates).length) throw httpError(400, "No fields provided");
    await row.update(updates);
    if (updates.invoiceStatus && row.projectId) {
        const project = await Project.findByPk(row.projectId);
        if (project && !["completed", "cancelled"].includes(project.status)) {
            if (updates.invoiceStatus === "paid") await project.update({ status: "completed" });
            else if (["invoiced", "partially_paid"].includes(updates.invoiceStatus)) await project.update({ status: "invoiced" });
        }
    }
    const changes = diff(before, row.get({ plain: true }), Object.keys(updates).filter((k) => k !== "systemSummary"));
    if (changes)
        await recordActivity({
            actor, ctx, businessUnitId: row.businessUnitId, entityType: "installation", entityId: row.id, entityLabel: row.opportunity?.number ?? null,
            action: changes.invoiceStatus ? `invoice_${row.invoiceStatus}` : "updated", changes,
        });
    return getInstallation(row.id, actor);
};

export const deleteInstallation = async (id, actor, ctx) => {
    const row = await loadInstallation(id, actor);
    await row.destroy();
    await recordActivity({ actor, ctx, businessUnitId: row.businessUnitId, entityType: "installation", entityId: row.id, entityLabel: row.opportunity?.number ?? null, action: "deleted" });
};

/** Dashboard counts for one unit. */
export const installationStats = async (businessUnitId) => {
    const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const rows = await Installation.findAll({ where: { businessUnitId }, attributes: ["installationDate", "invoiceStatus"], raw: true });
    return {
        total: rows.length,
        last30Days: rows.filter((r) => r.installationDate >= since).length,
        notInvoiced: rows.filter((r) => r.invoiceStatus === "not_invoiced").length,
        byInvoiceStatus: Object.fromEntries(INVOICE_STATUSES.map((s) => [s, rows.filter((r) => r.invoiceStatus === s).length])),
    };
};
