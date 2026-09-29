// The pure half of the site-visit form: what a coordinator may ask for, what
// a site member may send back, and how each side sees the result. No database
// here, so the staff routes and the public routes share one definition of the
// shape — and the public one can be read on its own to see exactly what an
// unauthenticated caller is ever shown.
//
// The field kinds and document types mirror
// prestige-fe/src/constants/inspectionReport.js and SiteVisitTaskForm.jsx.

import crypto from "node:crypto";

const httpError = (status, message, errors) => Object.assign(new Error(message), { status, ...(errors ? { errors } : {}) });

/** Controls the public form knows how to render. "files" is not one: photos are document slots. */
export const FIELD_KINDS = ["text", "textarea", "number", "date", "checkbox", "signature"];
export const DOCUMENT_TYPES = ["image", "document"];

const MAX_FIELDS = 60;
const MAX_DOCUMENTS = 30;

/** The link's whole authority: 32 characters of URL-safe randomness. */
export const newToken = () => crypto.randomBytes(24).toString("base64url");

/** Shape check before any lookup, so a junk path never reaches the database. */
export const isWellFormedToken = (token) => typeof token === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(token);

// C0/C1 controls, zero-width and bidi characters — never wanted in what
// someone types on a phone at a switchboard. Newlines survive in long text.
const CONTROL_CLASS = "\\u0000-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u2028\\u2029\\u202A-\\u202E\\u2060\\uFEFF";
const CONTROL_RE = new RegExp(`[${CONTROL_CLASS}]`, "g");
const CONTROL_KEEP_NEWLINES_RE = new RegExp(`[${CONTROL_CLASS.replace("\\u0000-\\u001F", "\\u0000-\\u0009\\u000B\\u000C\\u000E-\\u001F")}]`, "g");

const oneLine = (value, max) =>
    typeof value === "string" || typeof value === "number"
        ? String(value).slice(0, max * 2).replace(CONTROL_RE, " ").replace(/\s+/g, " ").trim()
        : "";

const multiLine = (value, max) =>
    typeof value === "string"
        ? value
              .slice(0, max * 2)
              .replace(/\r\n?/g, "\n")
              .replace(CONTROL_KEEP_NEWLINES_RE, "")
              .replace(/[^\S\n]+/g, " ")
              .replace(/\n{3,}/g, "\n\n")
              .trim()
        : "";

const isBlank = (value) => value === undefined || value === null || String(value).trim() === "";

// Keys are chosen by the coordinator's form (slugs of the labels, or the
// inspection checklist's own keys). Kept to a safe alphabet and made unique.
const keyOf = (raw, fallback) => {
    const cleaned = String(raw ?? "")
        .trim()
        .replace(/[^A-Za-z0-9_-]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 60);
    return cleaned || fallback;
};
const uniqueKeys = (items) => {
    const seen = new Set();
    return items.map((item) => {
        let key = item.key;
        for (let n = 2; seen.has(key); n += 1) key = `${item.key.slice(0, 56)}_${n}`;
        seen.add(key);
        return { ...item, key };
    });
};

// ---- What a coordinator asks for --------------------------------------------

/** [{ key, label, kind, hint? }] — the answers the site member is asked for. */
export const cleanRequestedFields = (value) => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw httpError(400, "requestedFields must be a list");
    if (value.length > MAX_FIELDS) throw httpError(400, `Ask for at most ${MAX_FIELDS} pieces of information`);
    const fields = value
        .map((field, i) => {
            const label = oneLine(field?.label, 160);
            if (!label) return null;
            const kind = FIELD_KINDS.includes(field?.kind) ? field.kind : "text";
            const hint = oneLine(field?.hint, 300);
            return { key: keyOf(field?.key, `field_${i + 1}`), label, kind, ...(hint ? { hint } : {}) };
        })
        .filter(Boolean);
    return uniqueKeys(fields);
};

/** [{ key, label, type, comment }] — one upload slot each on the public form. */
export const cleanRequestedDocuments = (value) => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw httpError(400, "requestedDocuments must be a list");
    if (value.length > MAX_DOCUMENTS) throw httpError(400, `Ask for at most ${MAX_DOCUMENTS} photos or documents`);
    const documents = value
        .map((doc, i) => {
            const label = oneLine(doc?.label, 160);
            if (!label) return null;
            return {
                key: keyOf(doc?.key, `document_${i + 1}`),
                label,
                type: DOCUMENT_TYPES.includes(doc?.type) ? doc.type : "image",
                comment: multiLine(doc?.comment, 500) || null,
            };
        })
        .filter(Boolean);
    return uniqueKeys(documents);
};

/** Pre-site inspection checklist keys, as marked on the request. */
export const cleanChecklistKeys = (value) => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw httpError(400, "inspectionChecklist must be a list of item keys");
    if (value.length > 150) throw httpError(400, "inspectionChecklist: at most 150 items");
    return [...new Set(value.map((key) => keyOf(key, "")).filter(Boolean))];
};

// ---- What a site member sends back ------------------------------------------

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const PHONE_RE = /^\+?[\d\s().-]+$/;
// A drawn signature from the form's canvas, and nothing that merely claims to be one.
const SIGNATURE_RE = /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/;
const MAX_SIGNATURE_CHARS = 500_000;

/**
 * Checks a submission against the fields the coordinator asked for. Returns
 * { clean, errors } — errors are [{ field, message }] with the same field
 * names the public form highlights ("name", "email", "phone", "field:<key>"),
 * listing every problem at once. Answers to fields nobody asked for are dropped.
 */
export const sanitizeSubmission = (body, requestedFields = []) => {
    const src = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    const errors = [];
    const fail = (field, message) => errors.push({ field, message });

    const name = oneLine(src.name, 100);
    if (!name) fail("name", "Enter your name.");
    else if (name.length > 100) fail("name", "Your name is too long (100 characters max).");

    const email = oneLine(src.email, 254).toLowerCase();
    const phone = oneLine(src.phone, 30);
    if (!email && !phone) fail("email", "Give an email or a phone number so we can reach you.");
    if (email && (email.length > 254 || !EMAIL_RE.test(email))) fail("email", "Enter a valid email address.");
    if (phone) {
        const digits = (phone.match(/\d/g) || []).length;
        if (!PHONE_RE.test(phone)) fail("phone", "A phone number can only contain digits, spaces and + ( ) - characters.");
        else if (digits < 8 || digits > 15) fail("phone", "Enter a valid phone number.");
    }

    const given = src.fields && typeof src.fields === "object" && !Array.isArray(src.fields) ? src.fields : {};
    const fields = {};
    for (const field of requestedFields) {
        const raw = given[field.key];
        const at = `field:${field.key}`;
        const needed = () => fail(at, `${field.label} is needed.`);

        // A checkbox answers "no" by staying unticked, so it is never missing.
        if (field.kind === "checkbox") {
            fields[field.key] = raw === true || raw === "true" || raw === 1 || raw === "1";
            continue;
        }
        if (isBlank(raw)) {
            needed();
            continue;
        }
        switch (field.kind) {
            case "signature":
                if (typeof raw !== "string" || raw.length > MAX_SIGNATURE_CHARS || !SIGNATURE_RE.test(raw))
                    fail(at, `${field.label} could not be read — please sign again.`);
                else fields[field.key] = raw;
                break;
            case "number": {
                const n = Number(raw);
                if (!Number.isFinite(n)) fail(at, `${field.label} must be a number.`);
                else fields[field.key] = n;
                break;
            }
            case "date": {
                const value = String(raw).slice(0, 10);
                if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(new Date(value).getTime()))
                    fail(at, `${field.label} must be a date.`);
                else fields[field.key] = value;
                break;
            }
            case "textarea": {
                const value = multiLine(raw, 5000);
                if (value.length > 5000) fail(at, `${field.label} is too long (5000 characters max).`);
                else if (!value) needed();
                else fields[field.key] = value;
                break;
            }
            default: {
                const value = oneLine(raw, 1000);
                if (value.length > 1000) fail(at, `${field.label} is too long (1000 characters max).`);
                else if (!value) needed();
                else fields[field.key] = value;
            }
        }
    }

    return { errors, clean: { name, email: email || null, phone: phone || null, fields } };
};

// ---- How each side sees it --------------------------------------------------

/** "12 Wharf Rd, Birchgrove NSW 2041" — the only job detail the public form ever shows. */
export const siteAddressOf = (opportunity) => {
    if (!opportunity) return null;
    const locality = [opportunity.siteSuburb, opportunity.siteState, opportunity.sitePostcode].filter(Boolean).join(" ");
    return [opportunity.siteLine1, locality].filter(Boolean).join(", ") || null;
};

const base = () => String(process.env.BACKEND_URL || "").replace(/\/$/, "");

/** A photo's address on the public side, opened with the link's token. */
export const publicPhotoUrl = (token, photoId) => `${base()}/api/public/site-visits/${encodeURIComponent(token)}/photos/${photoId}`;

const asList = (value) => (Array.isArray(value) ? value : []);

/**
 * The task as the coordinator's screen reads it (request.siteVisit). `photos`
 * are already-presented attachments with their signed-in download URLs. The
 * token — the public link — goes only to the people who run the visit.
 */
export const presentSiteVisit = (visit, { request, siteAddress, photos = [], includeToken = false }) => ({
    id: visit.id,
    token: includeToken ? visit.token : null,
    status: visit.status,
    submittedAt: visit.submittedAt ?? null,
    title: request.title,
    description: request.description ?? null,
    siteAddress: siteAddress ?? null,
    scheduledFor: request.scheduledFor ?? null,
    assigneeId: visit.assigneeId ?? null,
    assigneeName: visit.assigneeName ?? null,
    assigneeEmail: visit.assigneeEmail ?? null,
    assigneePhone: visit.assigneePhone ?? null,
    requestedFields: asList(visit.requestedFields),
    requestedDocuments: asList(visit.requestedDocuments),
    response: visit.response ?? null,
    photos: photos.map((photo) => ({
        id: photo.id,
        filename: photo.filename,
        url: photo.url,
        documentKey: photo.documentKey,
        mime: photo.mime,
        size: photo.size,
        createdAt: photo.createdAt,
    })),
    createdAt: visit.createdAt,
    updatedAt: visit.updatedAt,
});

/**
 * Everything an unauthenticated holder of the link is shown: what they were
 * asked to do and where, and what they have uploaded so far. Deliberately no
 * customer, no opportunity, no other job data, and not the answers once sent.
 */
export const presentPublicTask = (visit, request, opportunity, photos = []) => ({
    status: visit.status,
    submittedAt: visit.submittedAt ?? null,
    title: request.title,
    description: request.description ?? null,
    siteAddress: siteAddressOf(opportunity),
    scheduledFor: request.scheduledFor ?? null,
    assigneeName: visit.assigneeName ?? null,
    requestedFields: asList(visit.requestedFields),
    requestedDocuments: asList(visit.requestedDocuments),
    photos: photos.map((photo) => ({
        id: photo.id,
        filename: photo.filename,
        url: publicPhotoUrl(visit.token, photo.id),
        documentKey: photo.documentKey,
    })),
});
