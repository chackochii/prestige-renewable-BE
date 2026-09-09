// Lead-stage attachments on an opportunity: the client-meeting log (kept in
// the opportunities.meetings JSONB column) and uploaded documents (rows in
// documents, files on local disk under UPLOAD_DIR). Both are what the lead
// pack needs before a lead can be marked Qualified — see
// qualificationGateItems, which opportunityService enforces.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Op } from "sequelize";
import db from "../../../models/index.js";
import { parseId } from "../../../utils/ids.js";

const { Opportunity, Document } = db;

const httpError = (status, message) => Object.assign(new Error(message), { status });

// ---- Storage ----------------------------------------------------------------

export const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || "uploads");

const ALLOWED_EXTENSIONS = new Set([
    "jpg", "jpeg", "png", "gif", "webp", "heic", "bmp",
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv",
    "dwg", "dxf", "msg", "eml",
]);

export const DOCUMENT_TYPES = [
    "proposal", "energy_bill", "contract", "approval", "evidence", "site_photo", "drawing",
    "supplier_quote", "acceptance", "certificate", "insurance", "handover", "service", "lead", "other",
];

// Attachments that count as site evidence for qualification.
const SITE_EVIDENCE_TYPES = ["site_photo", "drawing"];

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

const absolutePath = (relative) => {
    const resolved = path.resolve(UPLOAD_DIR, relative);
    // A stored path must stay inside the upload directory.
    if (!resolved.startsWith(UPLOAD_DIR + path.sep)) throw httpError(400, "Invalid document path");
    return resolved;
};

const loadOpportunity = async (id) => {
    const opportunity = await Opportunity.findByPk(parseId(id, "opportunity id"));
    if (!opportunity) throw httpError(404, "Opportunity not found");
    return opportunity;
};

// ---- Qualification gate -----------------------------------------------------

/**
 * What is still missing before the lead can be marked Qualified: a logged
 * client meeting and at least one site photo or sketch. Empty = ready.
 */
export const qualificationGateItems = async (opportunity) => {
    const missing = [];
    if (!(Array.isArray(opportunity.meetings) ? opportunity.meetings : []).length)
        missing.push("a logged client meeting");
    const evidence = await Document.count({
        where: { opportunityId: opportunity.id, type: { [Op.in]: SITE_EVIDENCE_TYPES } },
    });
    if (!evidence) missing.push("a site photo or sketch");
    return missing;
};

// ---- Meetings ---------------------------------------------------------------

const MEETING_FIELDS = ["attendees", "outcome", "nextStep"];

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

const documentInclude = () => [{ model: db.User, as: "uploader", attributes: ["id", "name"] }];

/** Public shape of a document row: plain object plus the download URL. */
export const presentDocument = (doc) => {
    const plain = typeof doc.get === "function" ? doc.get({ plain: true }) : { ...doc };
    delete plain.url; // storage path — never leaves the server
    plain.fileUrl = `/api/opportunities/${plain.opportunityId}/documents/${plain.id}/file`;
    return plain;
};

export const listDocuments = async (id) => {
    const opportunity = await loadOpportunity(id);
    const docs = await Document.findAll({
        where: { opportunityId: opportunity.id },
        include: documentInclude(),
        order: [["createdAt", "DESC"]],
    });
    return docs.map(presentDocument);
};

/**
 * Stores uploaded files (multer memory buffers) and records one document row
 * each. meta: { type, stage, label } — type must be one of DOCUMENT_TYPES.
 */
export const addDocuments = async (id, files = [], meta = {}, actor) => {
    const opportunity = await loadOpportunity(id);
    if (!files.length) throw httpError(400, "Attach at least one file");

    const type = meta.type || "other";
    if (!DOCUMENT_TYPES.includes(type))
        throw httpError(400, `type must be one of: ${DOCUMENT_TYPES.join(", ")}`);
    let stage = null;
    if (meta.stage !== undefined && meta.stage !== "" && meta.stage !== null) {
        stage = Number(meta.stage);
        if (!Number.isInteger(stage) || stage < 1 || stage > 9) throw httpError(400, "stage must be 1–9");
    }
    const label = meta.label ? String(meta.label).slice(0, 50) : null;

    for (const file of files) {
        if (!ALLOWED_EXTENSIONS.has(extensionOf(file.originalname)))
            throw httpError(400, `${file.originalname}: file type not allowed`);
    }

    const folder = path.join("opportunities", String(opportunity.id));
    await fs.mkdir(path.join(UPLOAD_DIR, folder), { recursive: true });

    const created = [];
    for (const file of files) {
        const relative = path.join(folder, safeFileName(file.originalname));
        await fs.writeFile(path.join(UPLOAD_DIR, relative), file.buffer);
        const doc = await Document.create({
            opportunityId: opportunity.id,
            type,
            name: String(file.originalname).slice(0, 255),
            uploaderId: actor?.id ?? null,
            size: formatSize(file.size),
            url: relative.split(path.sep).join("/"),
            label,
            stage,
            mime: file.mimetype || "application/octet-stream",
            mirrorStatus: "pending",
        });
        created.push(doc.id);
    }

    const docs = await Document.findAll({ where: { id: created }, include: documentInclude() });
    return docs.map(presentDocument);
};

export const removeDocument = async (id, docId) => {
    const opportunity = await loadOpportunity(id);
    const doc = await Document.findOne({ where: { id: parseId(docId, "document id"), opportunityId: opportunity.id } });
    if (!doc) throw httpError(404, "Document not found");
    if (doc.url) {
        try {
            await fs.unlink(absolutePath(doc.url));
        } catch (err) {
            if (err.code !== "ENOENT" && err.status !== 400) throw err;
        }
    }
    await doc.destroy();
};

/** Resolves a document to its on-disk file for sending. */
export const getDocumentFile = async (id, docId) => {
    const opportunity = await loadOpportunity(id);
    const doc = await Document.findOne({ where: { id: parseId(docId, "document id"), opportunityId: opportunity.id } });
    if (!doc) throw httpError(404, "Document not found");
    if (!doc.url) throw httpError(404, "This document has no stored file");
    const filePath = absolutePath(doc.url);
    try {
        await fs.access(filePath);
    } catch {
        throw httpError(404, "The stored file is missing");
    }
    return { doc, filePath };
};
