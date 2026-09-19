// Lead-stage attachments on an opportunity: the client-meeting log (kept in
// the opportunities.meetings JSONB column) and uploaded documents (rows in
// documents, files in DigitalOcean Spaces — see utils/storage.js).
//
// Two views of the same documents exist: the generic document API (type,
// stage, label — used by later pipeline stages) and the lead screens'
// "attachments" (photo | sketch | bill | document categories, each with a
// URL the browser can open directly).
import crypto from "node:crypto";
import path from "node:path";
import db from "../../../models/index.js";
import { parseId } from "../../../utils/ids.js";
import { signDownloadToken } from "../../../utils/jwt.js";
import storage from "../../../utils/storage.js";

const { Opportunity, Document, User } = db;

const httpError = (status, message) => Object.assign(new Error(message), { status });

// ---- Storage ----------------------------------------------------------------

// MIME type by extension. The type a client declares in the multipart part is
// never stored — a browser would render it, so it must come from the server.
const MIME_BY_EXTENSION = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
    heic: "image/heic", bmp: "image/bmp",
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    txt: "text/plain", csv: "text/csv",
    dwg: "application/acad", dxf: "application/dxf",
    msg: "application/vnd.ms-outlook", eml: "message/rfc822",
};
const ALLOWED_EXTENSIONS = new Set(Object.keys(MIME_BY_EXTENSION));

/** Types the browser may render inline; everything else is sent as a download. */
export const INLINE_MIME = /^(image\/|application\/pdf$)/;

export const DOCUMENT_TYPES = [
    "proposal", "energy_bill", "contract", "approval", "evidence", "site_photo", "drawing",
    "supplier_quote", "acceptance", "certificate", "insurance", "handover", "service", "lead", "other",
];

// Attachment categories the lead screens use → document type.
export const ATTACHMENT_CATEGORIES = {
    photo: "site_photo",
    sketch: "drawing",
    bill: "energy_bill",
    document: "lead",
    client_document: "evidence", // what the client sends over during estimation
};
const CATEGORY_BY_TYPE = Object.fromEntries(Object.entries(ATTACHMENT_CATEGORIES).map(([c, t]) => [t, c]));

const formatSize = (bytes) => {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

const safeFileName = (name) => {
    const base = path.basename(String(name || "file")).replace(/[^\w.\-]+/g, "_").slice(0, 80) || "file";
    return `${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${base}`;
};

const extensionOf = (name) => path.extname(String(name || "")).slice(1).toLowerCase();

const loadOpportunity = async (id) => {
    const opportunity = await Opportunity.findByPk(parseId(id, "opportunity id"));
    if (!opportunity) throw httpError(404, "Opportunity not found");
    return opportunity;
};

/** True when the opportunity has at least one document of the given type. */
export const hasDocumentOfType = async (opportunityId, type) =>
    (await Document.count({ where: { opportunityId, type } })) > 0;

// ---- Meetings ---------------------------------------------------------------

const MEETING_FIELDS = ["attendees", "outcome", "nextStep"];

/** The meeting log, newest first. */
export const listMeetings = async (id) => {
    const opportunity = await loadOpportunity(id);
    return Array.isArray(opportunity.meetings) ? opportunity.meetings : [];
};

/** Adds a meeting to the log. attendees is required; at defaults to now. */
export const addMeeting = async (id, payload = {}, actor) => {
    const opportunity = await loadOpportunity(id);
    const meeting = {};
    for (const field of MEETING_FIELDS) meeting[field] = String(payload[field] ?? "").trim();
    if (!meeting.attendees) throw httpError(400, "attendees is required");
    for (const field of MEETING_FIELDS)
        if (meeting[field].length > 2000) throw httpError(400, `${field} is too long`);

    let at = new Date();
    if (payload.at) {
        at = new Date(payload.at);
        if (Number.isNaN(at.getTime())) throw httpError(400, "at must be a valid date");
    }

    const entry = {
        id: `mtg_${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`,
        at: at.toISOString(),
        ...meeting,
        actorId: actor?.id ?? null,
        actorName: actor?.name ?? null,
    };
    const meetings = [entry, ...(Array.isArray(opportunity.meetings) ? opportunity.meetings : [])];
    await opportunity.update({ meetings });
    return entry;
};

export const removeMeeting = async (id, meetingId) => {
    const opportunity = await loadOpportunity(id);
    const meetings = Array.isArray(opportunity.meetings) ? opportunity.meetings : [];
    if (!meetings.some((m) => m.id === meetingId)) throw httpError(404, "Meeting not found");
    await opportunity.update({ meetings: meetings.filter((m) => m.id !== meetingId) });
};

// ---- Documents --------------------------------------------------------------

const documentInclude = () => [{ model: User, as: "uploader", attributes: ["id", "name"] }];

/** Public shape of a document row: plain object plus the download path. */
export const presentDocument = (doc) => {
    const plain = typeof doc.get === "function" ? doc.get({ plain: true }) : { ...doc };
    delete plain.url; // storage path — never leaves the server
    plain.fileUrl = `/api/opportunities/${plain.opportunityId}/documents/${plain.id}/file`;
    return plain;
};

/**
 * Attachment shape for the lead screens: a category and a URL the browser can
 * open directly. The URL carries a download-only token (2 h) minted for the
 * requesting user, so the session token never appears in a link.
 */
export const presentAttachment = (doc, actor) => {
    const plain = presentDocument(doc);
    const base = String(process.env.BACKEND_URL || "").replace(/\/$/, "");
    const token = actor ? `?token=${signDownloadToken(actor, plain.id)}` : "";
    return {
        id: plain.id,
        opportunityId: plain.opportunityId,
        category: CATEGORY_BY_TYPE[plain.type] || "other",
        type: plain.type,
        filename: plain.name,
        size: plain.size,
        mime: plain.mime,
        stage: plain.stage,
        uploaderName: plain.uploader?.name ?? null,
        createdAt: plain.createdAt,
        url: `${base}${plain.fileUrl}${token}`,
    };
};

const findDocuments = async (opportunityId) =>
    Document.findAll({ where: { opportunityId }, include: documentInclude(), order: [["createdAt", "DESC"], ["id", "DESC"]] });

export const listDocuments = async (id) => {
    const opportunity = await loadOpportunity(id);
    return (await findDocuments(opportunity.id)).map(presentDocument);
};

export const listAttachments = async (id, actor) => {
    const opportunity = await loadOpportunity(id);
    return (await findDocuments(opportunity.id)).map((doc) => presentAttachment(doc, actor));
};

// Writes the files to storage and records one document row each. Returns the
// rows (with uploader) in the order given.
const storeFiles = async (opportunity, files, { type, stage, label }, actor) => {
    if (!files.length) throw httpError(400, "Attach at least one file");
    for (const file of files) {
        if (!ALLOWED_EXTENSIONS.has(extensionOf(file.originalname)))
            throw httpError(400, `${file.originalname}: file type not allowed`);
    }

    const created = [];
    for (const file of files) {
        const key = `opportunities/${opportunity.id}/${safeFileName(file.originalname)}`;
        const mime = MIME_BY_EXTENSION[extensionOf(file.originalname)] || "application/octet-stream";
        await storage.put(key, file.buffer, { contentType: mime });
        const doc = await Document.create({
            opportunityId: opportunity.id,
            type,
            name: String(file.originalname).slice(0, 255),
            uploaderId: actor?.id ?? null,
            size: formatSize(file.size),
            url: key,
            label,
            stage,
            mime,
            mirrorStatus: "pending",
        });
        created.push(doc.id);
    }

    const docs = await Document.findAll({ where: { id: created }, include: documentInclude() });
    return created.map((docId) => docs.find((d) => d.id === docId));
};

/**
 * Stores uploaded files (multer memory buffers) and records one document row
 * each. meta: { type, stage, label } — type must be one of DOCUMENT_TYPES.
 */
export const addDocuments = async (id, files = [], meta = {}, actor) => {
    const opportunity = await loadOpportunity(id);

    const type = meta.type || "other";
    if (!DOCUMENT_TYPES.includes(type))
        throw httpError(400, `type must be one of: ${DOCUMENT_TYPES.join(", ")}`);
    let stage = null;
    if (meta.stage !== undefined && meta.stage !== "" && meta.stage !== null) {
        stage = Number(meta.stage);
        if (!Number.isInteger(stage) || stage < 1 || stage > 9) throw httpError(400, "stage must be 1–9");
    }
    const label = meta.label ? String(meta.label).slice(0, 50) : null;

    const docs = await storeFiles(opportunity, files, { type, stage, label }, actor);
    return docs.map(presentDocument);
};

/** One file for the lead screens, keyed by category (photo | sketch | bill | document). */
export const addAttachment = async (id, file, category, actor) => {
    const opportunity = await loadOpportunity(id);
    const type = ATTACHMENT_CATEGORIES[category];
    if (!type) throw httpError(400, `category must be one of: ${Object.keys(ATTACHMENT_CATEGORIES).join(", ")}`);
    if (!file) throw httpError(400, 'Attach a file in the "file" field');
    const [doc] = await storeFiles(opportunity, [file], { type, stage: 1, label: null }, actor);
    return presentAttachment(doc, actor);
};

export const removeDocument = async (id, docId) => {
    const opportunity = await loadOpportunity(id);
    const doc = await Document.findOne({ where: { id: parseId(docId, "document id"), opportunityId: opportunity.id } });
    if (!doc) throw httpError(404, "Document not found");
    if (doc.url) {
        try {
            await storage.remove(doc.url);
        } catch (err) {
            // A stored path that fails validation can't point at a real file.
            if (err.status !== 400) throw err;
        }
    }
    await doc.destroy();
};

/** Opens a document's stored file for sending: { doc, file: { body (stream), size } }. */
export const getDocumentFile = async (id, docId) => {
    const opportunity = await loadOpportunity(id);
    const doc = await Document.findOne({ where: { id: parseId(docId, "document id"), opportunityId: opportunity.id } });
    if (!doc) throw httpError(404, "Document not found");
    if (!doc.url) throw httpError(404, "This document has no stored file");
    return { doc, file: await storage.open(doc.url) };
};
