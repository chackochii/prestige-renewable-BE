// Cross-department requests and assignments: one team asking another for
// information, or handing them work to do, from a pipeline stage.
//
// Who may do what (the frontend hides controls to match, but this is the
// enforcement):
//   read     — anyone with leads.read in the record's business unit, which the
//              routes check; internal progress notes and unsubmitted drafts
//              are still stripped for everyone but the assignee.
//   respond  — the assignee, on an information request
//   decide   — the requester, once a response is in
//   progress — the assignee, on an assignment
//   edit /
//   cancel   — the requester, while it is still open
//
// Every change writes a collaboration_events row (the history tab) and, where
// somebody is waiting on it, raises a notification.
import { Op } from "sequelize";
import db from "../../../models/index.js";
import { parseId } from "../../../utils/ids.js";
import storage from "../../../utils/storage.js";
import { signDownloadToken } from "../../../utils/jwt.js";
import { notify } from "../../notification/service/notificationService.js";
import { addAttachment as fileOnOpportunity } from "../../opportunity/service/leadAttachmentService.js";
import {
    DEPARTMENTS,
    REQUEST_KINDS,
    REQUEST_PRIORITIES,
    statusesFor,
} from "../model/collaborationRequest.js";

const {
    CollaborationRequest,
    CollaborationProgress,
    CollaborationAttachment,
    CollaborationEvent,
    Opportunity,
    User,
    UserBusinessUnit,
} = db;

const httpError = (status, message) => Object.assign(new Error(message), { status });

const KIND_PREFIX = { information: "REQ", assignment: "ASG" };
const OPEN_INFORMATION = ["pending", "clarification_required", "draft_saved", "responded", "under_review", "returned"];
const RESPONDABLE = ["pending", "clarification_required", "returned", "draft_saved"];
const DECIDABLE = ["responded", "under_review"];
const DECISIONS = ["accepted", "clarification_required", "returned"];
const MAX_FILE_KEY = 60;

const isRequester = (request, user) => Number(request.createdById) === Number(user?.id);
const isAssignee = (request, user) => Number(request.assigneeId) === Number(user?.id);

const isOpen = (request) =>
    request.kind === "assignment"
        ? !["report_submitted", "cancelled"].includes(request.status)
        : OPEN_INFORMATION.includes(request.status);

// ---- Presentation -----------------------------------------------------------

const attachmentUrl = (attachment, actor) => {
    const base = String(process.env.BACKEND_URL || "").replace(/\/$/, "");
    const path = `/api/collaboration/requests/${attachment.requestId}/attachments/${attachment.id}/file`;
    const token = actor ? `?token=${signDownloadToken(actor, attachment.id, "collaboration")}` : "";
    return `${base}${path}${token}`;
};

const presentAttachment = (attachment, actor) => ({
    id: attachment.id,
    filename: attachment.filename,
    mime: attachment.mime,
    size: attachment.size,
    category: attachment.category,
    documentKey: attachment.documentKey,
    uploadedByName: attachment.uploader?.name ?? null,
    createdAt: attachment.createdAt,
    url: attachmentUrl(attachment, actor),
});

const presentProgress = (entry) => ({
    id: entry.id,
    status: entry.status,
    note: entry.note,
    internal: entry.internal,
    at: entry.createdAt,
    byName: entry.author?.name ?? null,
});

/**
 * The shape the frontend reads. `actor` decides what is stripped: internal
 * progress notes and a response still in draft belong to the assignee alone.
 */
export const presentRequest = (request, actor) => {
    const plain = request.get({ plain: true });
    const forAssignee = isAssignee(request, actor);
    const attachments = (request.attachments ?? []).map((a) => presentAttachment(a, actor));
    const progress = (request.progress ?? [])
        .filter((entry) => forAssignee || !entry.internal)
        .map(presentProgress)
        .sort((a, b) => new Date(a.at) - new Date(b.at));

    const responded = Boolean(plain.responseSubmittedAt) || plain.responseDraft;
    const draftHidden = plain.responseDraft && !forAssignee;
    const latestProgress = progress.filter((entry) => !entry.internal).at(-1) ?? null;

    return {
        id: plain.id,
        code: `${KIND_PREFIX[plain.kind] || "REQ"}-${plain.id}`,
        kind: plain.kind,
        businessUnitId: plain.businessUnitId,
        opportunityId: plain.opportunityId,
        opportunityNumber: plain.opportunity?.number ?? null,
        opportunityName:
            plain.opportunity?.customerLegalName || plain.opportunity?.customerTradingName || null,
        stage: plain.stage,
        department: plain.department,
        title: plain.title,
        description: plain.description,
        requestedFields: plain.requestedFields ?? [],
        requestedDocuments: plain.requestedDocuments ?? [],
        createdById: plain.createdById,
        createdByName: plain.createdBy?.name ?? null,
        assigneeId: plain.assigneeId,
        assigneeName: plain.assignee?.name ?? null,
        priority: plain.priority,
        dueAt: plain.dueAt,
        scheduledFor: plain.scheduledFor,
        status: plain.status,
        clarificationNote: plain.clarificationNote,
        cancelledReason: plain.cancelledReason,
        createdAt: plain.createdAt,
        updatedAt: plain.updatedAt,
        latestUpdate: latestProgress
            ? { note: latestProgress.note, at: latestProgress.at, byName: latestProgress.byName }
            : plain.responseSubmittedAt
              ? {
                    note: plain.responseNote || "Response submitted",
                    at: plain.responseSubmittedAt,
                    byName: plain.responseSubmittedBy?.name ?? null,
                }
              : null,
        response:
            responded && !draftHidden
                ? {
                      fields: plain.responseFields ?? {},
                      note: plain.responseNote,
                      draft: plain.responseDraft,
                      submittedAt: plain.responseSubmittedAt,
                      submittedByName: plain.responseSubmittedBy?.name ?? null,
                      attachments: attachments.filter((a) => a.category === "attachment"),
                  }
                : null,
        reports: attachments.filter((a) => a.category === "report"),
        progress,
    };
};

const requestInclude = () => [
    { model: Opportunity, as: "opportunity", attributes: ["id", "number", "customerLegalName", "customerTradingName"] },
    { model: User, as: "createdBy", attributes: ["id", "name"] },
    { model: User, as: "assignee", attributes: ["id", "name"] },
    { model: User, as: "responseSubmittedBy", attributes: ["id", "name"] },
    { model: CollaborationProgress, as: "progress", include: [{ model: User, as: "author", attributes: ["id", "name"] }] },
    { model: CollaborationAttachment, as: "attachments", include: [{ model: User, as: "uploader", attributes: ["id", "name"] }] },
];

// ---- Loading & access -------------------------------------------------------

const loadRequest = async (id) => {
    const request = await CollaborationRequest.findByPk(parseId(id, "request id"), { include: requestInclude() });
    if (!request) throw httpError(404, "Request not found");
    return request;
};

/**
 * A request is readable by anyone who works in its business unit (the route
 * checks leads.read); ADM is unrestricted. Out of scope answers 404 rather
 * than 403 so the existence of other units' work is not leaked.
 */
export const assertReadable = (request, user) => {
    const units = Array.isArray(user?.businessUnitIds) ? user.businessUnitIds : [];
    const isAdmin = Array.isArray(user?.roles) && user.roles.includes("ADM");
    if (!isAdmin && !units.includes(request.businessUnitId)) throw httpError(404, "Request not found");
    return request;
};

const reload = async (request, actor) => presentRequest(await loadRequest(request.id), actor);

const recordEvent = (request, action, detail, actor) =>
    CollaborationEvent.create({
        requestId: request.id,
        action,
        detail: detail ? String(detail).slice(0, 2000) : null,
        actorId: actor?.id ?? null,
    });

const assertAssignable = async (userId, request) => {
    const user = await User.findByPk(parseId(userId, "assigneeId"), { attributes: ["id", "name", "status"] });
    if (!user) throw httpError(400, "Unknown user for assigneeId");
    if (user.status !== "active") throw httpError(400, `${user.name} is not an active account`);
    const link = await UserBusinessUnit.findOne({
        where: { userId: user.id, businessUnitId: request.businessUnitId },
        attributes: ["id"],
    });
    const isAdmin = await User.findOne({ where: { id: user.id, roles: { [Op.contains]: ["ADM"] } }, attributes: ["id"] });
    if (!link && !isAdmin) throw httpError(400, `${user.name} is not assigned to this business unit`);
    return user;
};

const customerOf = (request) =>
    request.opportunity?.customerLegalName || request.opportunity?.customerTradingName || "the customer";

const requestLabel = (request) => `${KIND_PREFIX[request.kind] || "REQ"}-${request.id}`;

// ---- Reads ------------------------------------------------------------------

/**
 * params: { businessUnitId, scope: assigned | raised | all, kind, department,
 *           status, opportunityId, overdue, page, pageSize }
 */
export const listRequests = async (user, params = {}) => {
    const units = Array.isArray(user?.businessUnitIds) ? user.businessUnitIds : [];
    const isAdmin = Array.isArray(user?.roles) && user.roles.includes("ADM");

    const where = {};
    if (params.businessUnitId) {
        const unitId = parseId(params.businessUnitId, "businessUnitId");
        if (!isAdmin && !units.includes(unitId)) throw httpError(403, "You do not work in that business unit");
        where.businessUnitId = unitId;
    } else if (!isAdmin) {
        where.businessUnitId = { [Op.in]: units.length ? units : [0] };
    }

    if (params.scope === "assigned") where.assigneeId = user.id;
    else if (params.scope === "raised") where.createdById = user.id;

    if (params.kind && REQUEST_KINDS.includes(params.kind)) where.kind = params.kind;
    if (params.department && DEPARTMENTS.includes(params.department)) where.department = params.department;
    if (params.status) where.status = params.status;
    if (params.opportunityId) where.opportunityId = parseId(params.opportunityId, "opportunityId");
    if (params.overdue === "true" || params.overdue === true) where.dueAt = { [Op.lt]: new Date() };

    const pageSize = Math.min(Math.max(Number(params.pageSize) || 50, 1), 200);
    const page = Math.max(Number(params.page) || 1, 1);

    const { rows, count } = await CollaborationRequest.findAndCountAll({
        where,
        include: requestInclude(),
        order: [["createdAt", "DESC"], ["id", "DESC"]],
        limit: pageSize,
        offset: (page - 1) * pageSize,
        distinct: true,
    });

    return { rows: rows.map((row) => presentRequest(row, user)), total: count, page, pageSize };
};

/** Everything raised against one job, for its stage panels. */
export const listForOpportunity = async (user, opportunityId) => {
    const rows = await CollaborationRequest.findAll({
        where: { opportunityId: parseId(opportunityId, "opportunity id") },
        include: requestInclude(),
        order: [["createdAt", "DESC"], ["id", "DESC"]],
    });
    return rows.map((row) => presentRequest(row, user));
};

export const getRequest = async (user, id) => {
    const request = assertReadable(await loadRequest(id), user);
    return presentRequest(request, user);
};

export const listHistory = async (user, id) => {
    const request = assertReadable(await loadRequest(id), user);
    const events = await CollaborationEvent.findAll({
        where: { requestId: request.id },
        include: [{ model: User, as: "actor", attributes: ["id", "name"] }],
        order: [["createdAt", "DESC"], ["id", "DESC"]],
    });
    return events.map((event) => ({
        id: event.id,
        action: event.action,
        detail: event.detail,
        byName: event.actor?.name ?? null,
        at: event.createdAt,
    }));
};

// ---- Raising & editing ------------------------------------------------------

const cleanFields = (value) =>
    (Array.isArray(value) ? value : [])
        .map((field) => ({
            key: String(field?.key ?? "").trim().slice(0, MAX_FILE_KEY),
            label: String(field?.label ?? "").trim().slice(0, 120),
            type: ["text", "textarea", "number", "date"].includes(field?.type) ? field.type : "text",
        }))
        .filter((field) => field.key);

const cleanDocuments = (value) =>
    (Array.isArray(value) ? value : [])
        .map((doc) => ({
            key: String(doc?.key ?? "").trim().slice(0, MAX_FILE_KEY),
            label: String(doc?.label ?? "").trim().slice(0, 120),
            type: ["image", "document"].includes(doc?.type) ? doc.type : "document",
            comment: String(doc?.comment ?? "").trim().slice(0, 500) || null,
        }))
        .filter((doc) => doc.key);

const parseDate = (value, field) => {
    if (value === undefined || value === null || value === "") return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw httpError(400, `${field} must be a valid date`);
    return date;
};

/** Raised from a stage of one opportunity. */
export const createRequest = async (user, opportunityId, payload = {}) => {
    const opportunity = await Opportunity.findByPk(parseId(opportunityId, "opportunity id"));
    if (!opportunity) throw httpError(404, "Opportunity not found");

    const kind = REQUEST_KINDS.includes(payload.kind) ? payload.kind : null;
    if (!kind) throw httpError(400, `kind must be one of: ${REQUEST_KINDS.join(", ")}`);
    if (!DEPARTMENTS.includes(payload.department))
        throw httpError(400, `department must be one of: ${DEPARTMENTS.join(", ")}`);
    const title = String(payload.title ?? "").trim();
    if (!title) throw httpError(400, "title is required");
    if (payload.priority && !REQUEST_PRIORITIES.includes(payload.priority))
        throw httpError(400, `priority must be one of: ${REQUEST_PRIORITIES.join(", ")}`);

    const draft = CollaborationRequest.build({
        businessUnitId: opportunity.businessUnitId,
        opportunityId: opportunity.id,
        kind,
        department: payload.department,
        stage: payload.stage ? Number(payload.stage) : opportunity.stage,
        title: title.slice(0, 200),
        description: payload.description ? String(payload.description).slice(0, 5000) : null,
        requestedFields: kind === "information" ? cleanFields(payload.requestedFields) : [],
        requestedDocuments: cleanDocuments(payload.requestedDocuments),
        createdById: user.id,
        priority: payload.priority || "medium",
        dueAt: parseDate(payload.dueAt, "dueAt"),
        scheduledFor: kind === "assignment" ? parseDate(payload.scheduledFor, "scheduledFor") : null,
        status: kind === "assignment" ? "requested" : "pending",
    });

    const assignee = payload.assigneeId ? await assertAssignable(payload.assigneeId, draft) : null;
    draft.assigneeId = assignee?.id ?? null;
    const request = await draft.save();

    await recordEvent(request, "Request raised", title, user);
    if (assignee)
        await notify({
            event: "request.created",
            title: `${requestLabel(request)}: ${title}`,
            body: `${user.name} asked ${kind === "assignment" ? "you to take this on" : "you for information"} on ${opportunity.number} — ${customerOf({ opportunity })}.`,
            userIds: [assignee.id],
            opportunity,
            actor: user,
        });

    return reload(request, user);
};

/** Requester edits: title, description, priority, dueAt, assigneeId. */
export const updateRequest = async (user, id, payload = {}) => {
    const request = assertReadable(await loadRequest(id), user);
    if (!isRequester(request, user)) throw httpError(403, "Only the person who raised this can change it");
    if (!isOpen(request)) throw httpError(400, "This request is closed");

    const fields = {};
    if (payload.title !== undefined) {
        const title = String(payload.title).trim();
        if (!title) throw httpError(400, "title cannot be blank");
        fields.title = title.slice(0, 200);
    }
    if (payload.description !== undefined)
        fields.description = payload.description ? String(payload.description).slice(0, 5000) : null;
    if (payload.priority !== undefined) {
        if (!REQUEST_PRIORITIES.includes(payload.priority))
            throw httpError(400, `priority must be one of: ${REQUEST_PRIORITIES.join(", ")}`);
        fields.priority = payload.priority;
    }
    if (payload.dueAt !== undefined) fields.dueAt = parseDate(payload.dueAt, "dueAt");

    let reassignedTo = null;
    if (payload.assigneeId !== undefined && Number(payload.assigneeId) !== Number(request.assigneeId)) {
        reassignedTo = payload.assigneeId ? await assertAssignable(payload.assigneeId, request) : null;
        fields.assigneeId = reassignedTo?.id ?? null;
    }

    await request.update(fields);
    await recordEvent(request, reassignedTo ? "Request reassigned" : "Request updated", reassignedTo?.name, user);
    if (reassignedTo)
        await notify({
            event: "request.created",
            title: `${requestLabel(request)}: ${request.title}`,
            body: `${user.name} passed this to you on ${request.opportunity?.number ?? "a record"}.`,
            userIds: [reassignedTo.id],
            opportunity: request.opportunity,
            actor: user,
        });

    return reload(request, user);
};

export const cancelRequest = async (user, id, payload = {}) => {
    const request = assertReadable(await loadRequest(id), user);
    if (!isRequester(request, user)) throw httpError(403, "Only the person who raised this can cancel it");
    if (!isOpen(request)) throw httpError(400, "This request is already closed");

    const reason = String(payload.reason ?? "").trim();
    await request.update({ status: "cancelled", cancelledReason: reason || null });
    await recordEvent(request, "Request cancelled", reason, user);
    if (request.assigneeId)
        await notify({
            event: "request.cancelled",
            title: `${requestLabel(request)} cancelled`,
            body: `${user.name} cancelled "${request.title}"${reason ? ` — ${reason}` : ""}.`,
            userIds: [request.assigneeId],
            opportunity: request.opportunity,
            actor: user,
        });

    return reload(request, user);
};

// ---- Answering an information request ---------------------------------------

/** body: { fields, note?, draft? } — a draft stays private to the assignee. */
export const submitResponse = async (user, id, payload = {}) => {
    const request = assertReadable(await loadRequest(id), user);
    if (request.kind !== "information") throw httpError(400, "Only information requests take a response");
    if (!isAssignee(request, user)) throw httpError(403, "Only the assignee can respond to this request");
    if (!RESPONDABLE.includes(request.status)) throw httpError(400, `A response cannot be added while this is ${request.status}`);

    const isDraft = Boolean(payload.draft);
    const fields = payload.fields && typeof payload.fields === "object" && !Array.isArray(payload.fields) ? payload.fields : {};
    const note = payload.note ? String(payload.note).slice(0, 5000) : null;

    await request.update({
        responseFields: fields,
        responseNote: note,
        responseDraft: isDraft,
        responseSubmittedAt: isDraft ? null : new Date(),
        responseSubmittedById: user.id,
        status: isDraft ? "draft_saved" : "responded",
    });

    await recordEvent(request, isDraft ? "Draft saved" : "Response submitted", note, user);
    if (!isDraft && request.createdById)
        await notify({
            event: "request.response.submitted",
            title: `Response on ${requestLabel(request)}`,
            body: `${user.name} answered "${request.title}"${request.opportunity?.number ? ` on ${request.opportunity.number}` : ""}.`,
            userIds: [request.createdById],
            opportunity: request.opportunity,
            actor: user,
        });

    return reload(request, user);
};

/** body: { outcome: accepted | clarification_required | returned, note? } */
export const decideResponse = async (user, id, payload = {}) => {
    const request = assertReadable(await loadRequest(id), user);
    if (request.kind !== "information") throw httpError(400, "Only information requests take a decision");
    if (!isRequester(request, user)) throw httpError(403, "Only the person who raised this can decide on the response");
    if (!DECIDABLE.includes(request.status)) throw httpError(400, "There is no response to decide on yet");
    if (!DECISIONS.includes(payload.outcome))
        throw httpError(400, `outcome must be one of: ${DECISIONS.join(", ")}`);

    const note = payload.note ? String(payload.note).slice(0, 5000) : null;
    if (payload.outcome !== "accepted" && !note)
        throw httpError(400, "Say what is still needed when sending a response back");

    await request.update({
        status: payload.outcome,
        clarificationNote: payload.outcome === "accepted" ? request.clarificationNote : note,
    });

    const accepted = payload.outcome === "accepted";
    await recordEvent(request, accepted ? "Response accepted" : "Clarification requested", note, user);
    if (request.assigneeId)
        await notify({
            event: accepted ? "request.response.accepted" : "request.clarification.requested",
            title: `${requestLabel(request)} ${accepted ? "accepted" : "needs more"}`,
            body: accepted
                ? `${user.name} accepted your response to "${request.title}".`
                : `${user.name} needs more on "${request.title}" — ${note}`,
            userIds: [request.assigneeId],
            opportunity: request.opportunity,
            actor: user,
        });

    return reload(request, user);
};

// ---- Working an assignment --------------------------------------------------

/** body: { status, note?, scheduledFor?, internal? } */
export const addProgress = async (user, id, payload = {}) => {
    const request = assertReadable(await loadRequest(id), user);
    if (request.kind !== "assignment") throw httpError(400, "Only assignments take progress updates");
    if (!isAssignee(request, user)) throw httpError(403, "Only the assignee can update progress");
    if (["cancelled", "report_submitted"].includes(request.status))
        throw httpError(400, "This assignment is closed");

    const status = payload.status || request.status;
    if (!statusesFor("assignment").includes(status)) throw httpError(400, `status "${status}" is not an assignment status`);
    const internal = Boolean(payload.internal);
    const note = payload.note ? String(payload.note).slice(0, 5000) : null;
    const scheduledFor = payload.scheduledFor !== undefined ? parseDate(payload.scheduledFor, "scheduledFor") : undefined;

    await request.update({
        status,
        ...(scheduledFor !== undefined ? { scheduledFor } : {}),
    });
    await CollaborationProgress.create({
        requestId: request.id,
        status,
        note,
        internal,
        authorId: user.id,
    });
    await recordEvent(request, internal ? "Internal progress note" : "Progress update", note, user);

    // Internal notes stay inside the department, so they raise nothing.
    if (!internal && request.createdById) {
        const event =
            status === "report_submitted"
                ? "assignment.report.submitted"
                : status === "completed"
                  ? "assignment.completed"
                  : ["scheduled", "rescheduled"].includes(status)
                    ? "assignment.schedule.changed"
                    : "assignment.progressed";
        await notify({
            event,
            title: `${requestLabel(request)}: ${status.replace(/_/g, " ")}`,
            body: `${user.name} updated "${request.title}"${note ? ` — ${note}` : ""}.`,
            userIds: [request.createdById],
            opportunity: request.opportunity,
            actor: user,
        });
    }

    return reload(request, user);
};

// ---- Files ------------------------------------------------------------------

const ALLOWED_MIME = /^(image\/(jpeg|png|gif|webp|heic|bmp)|application\/pdf|application\/msword|application\/vnd\.|text\/(plain|csv))/;

/** The assignee supplying a file, or either side attaching a report. */
export const addRequestAttachment = async (user, id, category, file, documentKey) => {
    const request = assertReadable(await loadRequest(id), user);
    if (!file) throw httpError(400, 'Attach a file in the "file" field');
    if (!isAssignee(request, user) && !isRequester(request, user))
        throw httpError(403, "Only the people on this request can attach files");
    if (!["attachment", "report"].includes(category || "attachment"))
        throw httpError(400, "category must be attachment or report");

    const safe = String(file.originalname || "file").replace(/[^\w.\-]+/g, "_").slice(0, 80);
    const mime = file.mimetype && ALLOWED_MIME.test(file.mimetype) ? file.mimetype : "application/octet-stream";
    const key = `collaboration/${request.id}/${Date.now()}-${safe}`;
    await storage.put(key, file.buffer, { contentType: mime });

    const attachment = await CollaborationAttachment.create({
        requestId: request.id,
        category: category || "attachment",
        documentKey: documentKey ? String(documentKey).slice(0, MAX_FILE_KEY) : null,
        filename: String(file.originalname).slice(0, 255),
        mime,
        size: file.size,
        storageKey: key,
        uploaderId: user.id,
    });

    await recordEvent(request, "File uploaded", file.originalname, user);
    const fresh = await loadRequest(request.id);
    return {
        request: presentRequest(fresh, user),
        attachment: presentAttachment(
            await CollaborationAttachment.findByPk(attachment.id, { include: [{ model: User, as: "uploader", attributes: ["id", "name"] }] }),
            user
        ),
    };
};

/** Streams a request attachment back — the file itself never leaves via a link. */
export const getAttachmentFile = async (user, id, attachmentId) => {
    const request = assertReadable(await loadRequest(id), user);
    const attachment = await CollaborationAttachment.findOne({
        where: { id: parseId(attachmentId, "attachment id"), requestId: request.id },
    });
    if (!attachment) throw httpError(404, "Attachment not found");
    return { attachment, file: await storage.open(attachment.storageKey) };
};

/**
 * Copies a supplied file into the job's own attachments, so the requester can
 * work with it where they expect it. body: { attachmentId, category }.
 */
export const fileAttachmentOnOpportunity = async (user, id, payload = {}) => {
    const request = assertReadable(await loadRequest(id), user);
    if (!isRequester(request, user)) throw httpError(403, "Only the person who raised this can file it on the job");

    const attachment = await CollaborationAttachment.findOne({
        where: { id: parseId(payload.attachmentId, "attachmentId"), requestId: request.id },
    });
    if (!attachment) throw httpError(404, "Attachment not found");

    const { body } = await storage.open(attachment.storageKey);
    const chunks = [];
    for await (const chunk of body) chunks.push(chunk);

    // Reuses the opportunity's own attachment path, so the file is named,
    // typed and listed exactly like one uploaded there directly.
    await fileOnOpportunity(
        request.opportunityId,
        { originalname: attachment.filename, buffer: Buffer.concat(chunks), size: attachment.size },
        payload.category,
        user
    );
    await recordEvent(request, "Filed on the job", `${attachment.filename} → ${payload.category}`, user);

    return reload(request, user);
};

// ---- Overdue ----------------------------------------------------------------

/** Open requests past their due date, for the notification watcher. */
export const overdueRequests = async (since) =>
    CollaborationRequest.findAll({
        where: {
            dueAt: { [Op.lt]: new Date(), [Op.gt]: since },
            status: { [Op.notIn]: ["accepted", "cancelled", "report_submitted"] },
            assigneeId: { [Op.ne]: null },
        },
        include: [{ model: Opportunity, as: "opportunity", attributes: ["id", "number"] }],
    });
