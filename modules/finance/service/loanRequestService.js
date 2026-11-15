// Loan requests: finance applications submitted by sales on a lead and worked
// by finance. Sales raises one (loans.create) with the amount and financier;
// finance reviews it (loans.update) — moving it through under_review,
// more_info, approved or declined — replies to the representative, attaches
// the financier's response (a file on the job, documents.type "finance") and
// may delete a request (loans.delete). Every step notifies the other side and
// lands in the activity log and the job's history.
import { Op } from "sequelize";
import db from "../../../models/index.js";
import storage from "../../../utils/storage.js";
import { parseId } from "../../../utils/ids.js";
import { pagingOf } from "../../../utils/pagination.js";
import { assertUnitAccess, canAccessUnit, unitScopeOf } from "../../../utils/unitScope.js";
import { userHasPermission } from "../../role/service/roleService.js";
import { recordActivity, diff } from "../../activity/service/activityService.js";
import { notify } from "../../notification/service/notificationService.js";
import { recordSystemEvent } from "../../opportunity/service/leadWorkflowService.js";
import { customerLabel } from "../../opportunity/service/opportunityPeople.js";
import { MIME_BY_EXTENSION, extensionOf, leadFolder, presentDocument } from "../../opportunity/service/leadAttachmentService.js";
import { LOAN_STATUSES, OPEN_LOAN_STATUSES } from "../model/loanRequest.js";
import { httpError, isBlank, optionalText, optionalLongText, money, wholeNumber, dateOnly, oneOf, today, nextCode, userBrief } from "../../equipment/service/shared.js";

const { LoanRequest, LoanRequestMessage, Opportunity, BusinessUnit, User, Document, sequelize } = db;

/** The role told when an application comes in or the representative replies. */
export const FINANCE_ROLE = "FIN";
// Files on a loan request are the finance approval's evidence: stored on the
// job as approval documents (a type and category the job screens already
// know), labelled loan_<id> so the request can find its own.
const LOAN_DOCUMENT_TYPE = "approval";
const LOAN_DOCUMENT_CATEGORY = "approval";

const fmt = (value) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(Number(value) || 0);

const INCLUDE = [
    { model: Opportunity, as: "opportunity", attributes: ["id", "number", "stage", "lifecycle", "customerLegalName", "customerTradingName", "salespersonId", "siteSuburb"] },
    { model: BusinessUnit, as: "businessUnit", attributes: ["id", "code", "name"] },
    { model: User, as: "salesRep", attributes: ["id", "name"] },
    { model: User, as: "submittedBy", attributes: ["id", "name"] },
    { model: User, as: "reviewedBy", attributes: ["id", "name"] },
];
const MESSAGE_INCLUDE = [{ model: User, as: "author", attributes: ["id", "name"] }];

const presentMessage = (row) => ({
    id: row.id,
    kind: row.kind,
    body: row.body,
    author: userBrief(row.author),
    createdAt: row.createdAt,
});

export const presentLoanRequest = (row, { messages = null, attachments = null } = {}) => ({
    id: row.id,
    number: row.number,
    status: row.status,
    open: OPEN_LOAN_STATUSES.includes(row.status),
    lead: row.opportunity ? { id: row.opportunity.id, number: row.opportunity.number, stage: row.opportunity.stage, lifecycle: row.opportunity.lifecycle, customer: customerLabel(row.opportunity), suburb: row.opportunity.siteSuburb ?? null } : { id: row.opportunityId },
    businessUnit: row.businessUnit ? { id: row.businessUnit.id, code: row.businessUnit.code, name: row.businessUnit.name } : { id: row.businessUnitId },
    customer: { name: row.customerName, email: row.customerEmail, phone: row.customerPhone, address: row.customerAddress },
    loanAmount: Number(row.loanAmount),
    depositAmount: row.depositAmount === null || row.depositAmount === undefined ? null : Number(row.depositAmount),
    termMonths: row.termMonths ?? null,
    financier: row.financier ?? null,
    salesRep: userBrief(row.salesRep),
    submittedBy: userBrief(row.submittedBy),
    applicationDate: row.applicationDate,
    reviewedBy: userBrief(row.reviewedBy),
    decidedAt: row.decidedAt ?? null,
    financierReference: row.financierReference ?? null,
    financierResponse: row.financierResponse ?? null,
    financierResponseAt: row.financierResponseAt ?? null,
    notes: row.notes ?? null,
    ...(messages ? { messages } : {}),
    ...(attachments ? { attachments } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
});

const loadRequest = async (id, actor) => {
    const row = await LoanRequest.findByPk(parseId(id, "loan request id"), { include: INCLUDE });
    if (!row || !canAccessUnit(actor, row.businessUnitId)) throw httpError(404, "Loan request not found");
    return row;
};

const attachmentsFor = (row) =>
    Document.findAll({
        where: { opportunityId: row.opportunityId, type: LOAN_DOCUMENT_TYPE, label: `loan_${row.id}` },
        include: [{ model: User, as: "uploader", attributes: ["id", "name"] }],
        order: [["createdAt", "DESC"]],
    });

const full = async (row) => {
    const [messages, attachments] = await Promise.all([
        LoanRequestMessage.findAll({ where: { loanRequestId: row.id }, include: MESSAGE_INCLUDE, order: [["createdAt", "ASC"], ["id", "ASC"]] }),
        attachmentsFor(row),
    ]);
    return presentLoanRequest(row, { messages: messages.map(presentMessage), attachments: attachments.map(presentDocument) });
};

/** Who hears about a request: the representative, whoever submitted it, and (when there is one) the reviewer. */
const peopleOn = (row) => [...new Set([row.salesRepId, row.submittedById, row.reviewedById].filter(Boolean))];

const addMessage = (row, kind, body, actor) => LoanRequestMessage.create({ loanRequestId: row.id, authorId: actor?.id ?? null, kind, body });

// ---- Reads ----------------------------------------------------------------

/** ?businessUnitId=&status=&open=1&salesRepId=&opportunityId=&search=&page=&pageSize= — the caller's units; a representative without loans.update sees their own. */
export const listLoanRequests = async (query = {}, actor) => {
    const where = {};
    const scope = unitScopeOf(actor);
    if (!isBlank(query.businessUnitId)) {
        const unitId = parseId(query.businessUnitId, "businessUnitId");
        assertUnitAccess(actor, unitId);
        where.businessUnitId = unitId;
    } else if (scope) where.businessUnitId = { [Op.in]: scope };
    if (query.status) where.status = oneOf(query.status, LOAN_STATUSES, "status");
    if (query.open === "1" || query.open === "true") where.status = { [Op.in]: OPEN_LOAN_STATUSES };
    if (!isBlank(query.salesRepId)) where.salesRepId = parseId(query.salesRepId, "salesRepId");
    if (!isBlank(query.opportunityId)) where.opportunityId = parseId(query.opportunityId, "opportunityId");
    // Someone who may only create and read (a representative) sees the applications they are on.
    if (!(await userHasPermission(actor, "loans.update"))) where[Op.or] = [{ salesRepId: actor.id }, { submittedById: actor.id }];
    const include = INCLUDE.map((i) => ({ ...i }));
    if (query.search) {
        const term = `%${String(query.search).trim().slice(0, 100)}%`;
        where[Op.and] = [{ [Op.or]: [{ number: { [Op.iLike]: term } }, { customerName: { [Op.iLike]: term } }, { customerEmail: { [Op.iLike]: term } }, { customerPhone: { [Op.iLike]: term } }, { financier: { [Op.iLike]: term } }, { "$opportunity.number$": { [Op.iLike]: term } }] }];
    }
    const paging = pagingOf(query, { defaultSize: 12, maxSize: 100 });
    const { rows, count } = await LoanRequest.findAndCountAll({ where, include, order: [["createdAt", "DESC"], ["id", "DESC"]], limit: paging.limit, offset: paging.offset, distinct: true, subQuery: false });
    // The chips count every status under the same filters, search aside.
    const countWhere = { ...where };
    delete countWhere.status;
    delete countWhere[Op.and];
    const counts = await LoanRequest.findAll({
        attributes: ["status", [sequelize.fn("COUNT", sequelize.col("id")), "n"]],
        where: countWhere,
        group: ["status"],
        raw: true,
    });
    const byStatus = Object.fromEntries(LOAN_STATUSES.map((s) => [s, 0]));
    for (const c of counts) byStatus[c.status] = Number(c.n);
    return { data: rows.map((row) => presentLoanRequest(row)), total: count, page: paging.page, pageSize: paging.pageSize, counts: { ...byStatus, open: OPEN_LOAN_STATUSES.reduce((n, s) => n + byStatus[s], 0) } };
};

export const getLoanRequest = async (id, actor) => full(await loadRequest(id, actor));

// ---- Writes ---------------------------------------------------------------

// Loan numbers are per unit; an advisory lock (its own first key) keeps two
// submissions at once from taking the same number.
const LOAN_NUMBERING_LOCK_KEY = 3;

const nextNumber = async (unit, transaction) => {
    await sequelize.query("SELECT pg_advisory_xact_lock(:key, :unitId)", { replacements: { key: LOAN_NUMBERING_LOCK_KEY, unitId: unit.id }, transaction });
    const year = String(new Date().getFullYear()).slice(-2);
    const prefix = `${unit.code}-LN-${year}-`;
    const existing = await LoanRequest.findAll({ where: { number: { [Op.like]: `${prefix}%` } }, attributes: ["number"], paranoid: false, transaction, raw: true });
    return nextCode(prefix, existing.map((r) => r.number), 4);
};

/**
 * { opportunityId, loanAmount, depositAmount?, termMonths?, financier?, applicationDate?, notes?, salesRepId? }
 * The customer's details come off the lead; the representative is the lead's salesperson unless named.
 */
export const createLoanRequest = async (payload = {}, actor, ctx) => {
    const opportunity = await Opportunity.findByPk(parseId(payload.opportunityId, "opportunityId"));
    if (!opportunity || !canAccessUnit(actor, opportunity.businessUnitId)) throw httpError(404, "Opportunity not found");
    if (opportunity.lifecycle !== "Active") throw httpError(400, "Only an active job can have a finance application");
    const unit = await BusinessUnit.findByPk(opportunity.businessUnitId);
    const loanAmount = money(payload.loanAmount, "loanAmount", { min: 0.01 });
    const salesRepId = isBlank(payload.salesRepId) ? (opportunity.salespersonId ?? actor?.id ?? null) : parseId(payload.salesRepId, "salesRepId");
    if (salesRepId && !(await User.findByPk(salesRepId, { attributes: ["id"] }))) throw httpError(400, "Unknown sales representative");
    const open = await LoanRequest.findOne({ where: { opportunityId: opportunity.id, status: { [Op.in]: OPEN_LOAN_STATUSES } } });
    if (open) throw httpError(409, `${open.number} is already open on this job — update it rather than submitting a second application`);

    const address = [opportunity.siteLine1, opportunity.siteSuburb, opportunity.siteState, opportunity.sitePostcode].filter(Boolean).join(", ") || opportunity.customerBillingAddress || null;
    const row = await sequelize.transaction(async (transaction) =>
        LoanRequest.create(
            {
                opportunityId: opportunity.id,
                businessUnitId: opportunity.businessUnitId,
                number: await nextNumber(unit, transaction),
                customerName: customerLabel(opportunity),
                customerEmail: opportunity.customerEmail ?? opportunity.contactEmail ?? null,
                customerPhone: opportunity.customerPhone ?? opportunity.contactPhone ?? null,
                customerAddress: address,
                loanAmount,
                depositAmount: money(payload.depositAmount, "depositAmount", { allowNull: true }),
                termMonths: wholeNumber(payload.termMonths, "termMonths", { allowNull: true, min: 1 }),
                financier: optionalText(payload.financier, "financier", 120),
                salesRepId,
                submittedById: actor?.id ?? null,
                applicationDate: dateOnly(payload.applicationDate, "applicationDate") ?? today(),
                status: "submitted",
                notes: optionalLongText(payload.notes, "notes", 5000),
            },
            { transaction }
        )
    );
    await addMessage(row, "status", `Application submitted for ${fmt(loanAmount)}${row.financier ? ` to ${row.financier}` : ""}.`, actor);
    await recordSystemEvent(opportunity, `Finance application ${row.number} submitted for ${fmt(loanAmount)}${row.financier ? ` (${row.financier})` : ""}.`, actor);
    await recordActivity({ actor, ctx, businessUnitId: row.businessUnitId, entityType: "loan_request", entityId: row.id, entityLabel: row.number, action: "submitted", meta: { opportunity: opportunity.number, loanAmount, financier: row.financier } });
    await notify({
        event: "loan.submitted",
        title: `${row.number}: finance application for ${opportunity.number}`,
        body: `${customerLabel(opportunity)} — ${fmt(loanAmount)}${row.financier ? ` with ${row.financier}` : ""}${actor?.name ? `, submitted by ${actor.name}` : ""}.`,
        roleCode: FINANCE_ROLE,
        opportunity,
        actor,
    });
    return full(await loadRequest(row.id, actor));
};

const EDITABLE = ["loanAmount", "depositAmount", "termMonths", "financier", "applicationDate", "notes", "salesRepId"];

/** Sales corrects an open application it is on; finance (loans.update) edits any. */
export const updateLoanRequest = async (id, payload = {}, actor, ctx) => {
    const row = await loadRequest(id, actor);
    const reviewer = await userHasPermission(actor, "loans.update");
    const own = [row.salesRepId, row.submittedById].includes(actor.id);
    if (!reviewer && !own) throw httpError(403, "Only the representative on the application or finance can change it");
    if (!reviewer && !OPEN_LOAN_STATUSES.includes(row.status)) throw httpError(409, `A ${row.status} application can no longer be changed by the representative`);
    const before = { ...row.get({ plain: true }) }; // a copy: without includes Sequelize hands back the live dataValues
    const updates = {};
    if (payload.loanAmount !== undefined) updates.loanAmount = money(payload.loanAmount, "loanAmount", { min: 0.01 });
    if (payload.depositAmount !== undefined) updates.depositAmount = money(payload.depositAmount, "depositAmount", { allowNull: true });
    if (payload.termMonths !== undefined) updates.termMonths = wholeNumber(payload.termMonths, "termMonths", { allowNull: true, min: 1 });
    if (payload.financier !== undefined) updates.financier = optionalText(payload.financier, "financier", 120);
    if (payload.applicationDate !== undefined) updates.applicationDate = dateOnly(payload.applicationDate, "applicationDate") ?? row.applicationDate;
    if (payload.notes !== undefined) updates.notes = optionalLongText(payload.notes, "notes", 5000);
    if (payload.salesRepId !== undefined) {
        const repId = isBlank(payload.salesRepId) ? null : parseId(payload.salesRepId, "salesRepId");
        if (repId && !(await User.findByPk(repId, { attributes: ["id"] }))) throw httpError(400, "Unknown sales representative");
        updates.salesRepId = repId;
    }
    if (payload.status !== undefined) throw httpError(400, "Use the review endpoint to change the status");
    if (!Object.keys(updates).length) throw httpError(400, `No fields provided. Editable: ${EDITABLE.join(", ")}`);
    await row.update(updates);
    const changes = diff(before, row.get({ plain: true }), Object.keys(updates));
    if (changes) await recordActivity({ actor, ctx, businessUnitId: row.businessUnitId, entityType: "loan_request", entityId: row.id, entityLabel: row.number, action: "updated", changes });
    return full(await loadRequest(row.id, actor));
};

/**
 * Finance reviews: { status, comments?, financierReference?, financierResponse? }.
 * The representative hears the outcome; a financier response is kept on the
 * request and echoed into the conversation.
 */
export const reviewLoanRequest = async (id, payload = {}, actor, ctx) => {
    const row = await loadRequest(id, actor);
    const status = oneOf(payload.status, LOAN_STATUSES, "status");
    const comments = optionalLongText(payload.comments, "comments", 5000);
    if (status === "withdrawn" && !comments) throw httpError(400, "Say why the application is withdrawn (comments)");
    if (status === "more_info" && !comments) throw httpError(400, "Say what more is needed (comments)");
    const before = { ...row.get({ plain: true }) }; // a copy: without includes Sequelize hands back the live dataValues
    const decided = ["approved", "declined", "withdrawn"].includes(status);
    const updates = { status, reviewedById: actor?.id ?? null, decidedAt: decided ? new Date() : null };
    if (payload.financierReference !== undefined) updates.financierReference = optionalText(payload.financierReference, "financierReference", 120);
    if (payload.financierResponse !== undefined) {
        updates.financierResponse = optionalLongText(payload.financierResponse, "financierResponse", 10000);
        updates.financierResponseAt = updates.financierResponse ? new Date() : null;
    }
    await row.update(updates);
    const label = status.replace("_", " ");
    await addMessage(row, "status", `Status: ${label}${comments ? ` — ${comments}` : ""}`, actor);
    if (updates.financierResponse) await addMessage(row, "financier", updates.financierResponse, actor);
    const opportunity = row.opportunity ?? (await Opportunity.findByPk(row.opportunityId));
    await recordSystemEvent(opportunity, `Finance application ${row.number} ${label}${comments ? `: ${comments}` : ""}.`, actor);
    await recordActivity({ actor, ctx, businessUnitId: row.businessUnitId, entityType: "loan_request", entityId: row.id, entityLabel: row.number, action: `review_${status}`, changes: diff(before, row.get({ plain: true }), Object.keys(updates)), meta: { comments } });
    await notify({
        event: "loan.decided",
        title: `${row.number} ${label}: ${opportunity.number}`,
        body: `${row.customerName ?? customerLabel(opportunity)} — ${fmt(row.loanAmount)}${row.financier ? ` with ${row.financier}` : ""} is ${label}${actor?.name ? ` (${actor.name})` : ""}.${comments ? ` ${comments}` : ""}`,
        userIds: peopleOn(row),
        opportunity,
        actor,
    });
    return full(await loadRequest(row.id, actor));
};

/** A reply on the request: { body }. Finance's reply reaches the representative; the representative's reaches finance. */
export const replyOnLoanRequest = async (id, payload = {}, actor, ctx) => {
    const row = await loadRequest(id, actor);
    const body = optionalLongText(payload.body, "body", 5000);
    if (!body) throw httpError(400, "body is required");
    const reviewer = await userHasPermission(actor, "loans.update");
    const own = [row.salesRepId, row.submittedById].includes(actor.id);
    if (!reviewer && !own) throw httpError(403, "Only the representative on the application or finance can reply");
    const message = await addMessage(row, "reply", body, actor);
    const opportunity = row.opportunity ?? (await Opportunity.findByPk(row.opportunityId));
    await recordActivity({ actor, ctx, businessUnitId: row.businessUnitId, entityType: "loan_request", entityId: row.id, entityLabel: row.number, action: "replied", meta: { messageId: message.id } });
    const notice = { event: "loan.reply", title: `${row.number}: reply on the finance application`, body: `${actor?.name ?? "Someone"}: ${body.slice(0, 300)}`, opportunity, actor };
    if (own && !reviewer) await notify({ ...notice, roleCode: FINANCE_ROLE, userIds: [row.reviewedById].filter(Boolean) });
    else await notify({ ...notice, userIds: peopleOn(row) });
    return full(await loadRequest(row.id, actor));
};

/** A file on the request (the financier's response, a signed form): stored on the job as a "finance" document labelled loan_<id>. */
export const attachToLoanRequest = async (id, file, payload = {}, actor, ctx) => {
    const row = await loadRequest(id, actor);
    if (!file) throw httpError(400, 'Attach a file in the "file" field');
    const ext = extensionOf(file.originalname);
    const mime = MIME_BY_EXTENSION[ext];
    if (!mime) throw httpError(400, `File type .${ext || "?"} is not allowed`);
    const opportunity = row.opportunity ?? (await Opportunity.findByPk(row.opportunityId));
    const safeName = String(file.originalname).replace(/[\\/:*?"<>|]+/g, "_").slice(0, 150);
    const key = `${leadFolder(opportunity)}/finance/${row.number}-${Date.now()}-${safeName}`;
    const storageUrl = await storage.put(key, file.buffer, { contentType: mime, filename: file.originalname });
    const doc = await Document.create({
        opportunityId: opportunity.id,
        type: LOAN_DOCUMENT_TYPE,
        name: file.originalname,
        uploaderId: actor?.id ?? null,
        size: String(file.size),
        url: key,
        storageUrl,
        category: LOAN_DOCUMENT_CATEGORY,
        label: `loan_${row.id}`,
        stage: Number(opportunity.stage) || null,
        mime,
    });
    const note = optionalText(payload.note, "note", 500);
    await addMessage(row, "financier", `File attached: ${file.originalname}${note ? ` — ${note}` : ""}`, actor);
    await recordActivity({ actor, ctx, businessUnitId: row.businessUnitId, entityType: "loan_request", entityId: row.id, entityLabel: row.number, action: "file_attached", meta: { documentId: doc.id, filename: file.originalname } });
    await notify({ event: "loan.reply", title: `${row.number}: document attached`, body: `${actor?.name ?? "Someone"} attached ${file.originalname}${note ? ` — ${note}` : ""}.`, userIds: peopleOn(row), opportunity, actor });
    return full(await loadRequest(row.id, actor));
};

export const deleteLoanRequest = async (id, payload = {}, actor, ctx) => {
    const row = await loadRequest(id, actor);
    const reason = optionalText(payload.reason, "reason", 500);
    await row.destroy(); // soft delete: the number stays taken and the trail stays readable
    const opportunity = row.opportunity ?? (await Opportunity.findByPk(row.opportunityId));
    if (opportunity) await recordSystemEvent(opportunity, `Finance application ${row.number} deleted${reason ? `: ${reason}` : ""}.`, actor);
    await recordActivity({ actor, ctx, businessUnitId: row.businessUnitId, entityType: "loan_request", entityId: row.id, entityLabel: row.number, action: "deleted", meta: { reason } });
};

/** Counts and amounts for the dashboard, one unit. */
export const loanStats = async (businessUnitId) => {
    const rows = await LoanRequest.findAll({ where: { businessUnitId }, attributes: ["status", "loanAmount"], raw: true });
    const byStatus = Object.fromEntries(LOAN_STATUSES.map((s) => [s, 0]));
    let approvedAmount = 0;
    let openAmount = 0;
    for (const r of rows) {
        byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
        if (r.status === "approved") approvedAmount += Number(r.loanAmount);
        if (OPEN_LOAN_STATUSES.includes(r.status)) openAmount += Number(r.loanAmount);
    }
    return { total: rows.length, open: OPEN_LOAN_STATUSES.reduce((n, s) => n + byStatus[s], 0), byStatus, approvedAmount: Math.round(approvedAmount * 100) / 100, openAmount: Math.round(openAmount * 100) / 100 };
};
