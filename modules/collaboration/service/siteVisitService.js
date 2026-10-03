// Site-visit forms: a coordinator hands one to whoever is attending an
// assignment, and that person fills it in on their phone from a link — no
// sign-in, because they may be a contractor's electrician with no account.
//
// Two audiences, so two halves:
//   staff  — create/replace the form, remove a bad photo (signed in, scoped to
//            the request's business unit like everything else on a request)
//   public — read the form, upload photos, submit (the token in the link is the
//            caller's whole authority: one form, nothing else)
//
// What a public caller is ever shown is decided in siteVisitShape.js
// (presentPublicTask) — no customer, no opportunity, no other job data.

import crypto from "node:crypto";
import path from "node:path";
import db from "../../../models/index.js";
import storage from "../../../utils/storage.js";
import { parseId } from "../../../utils/ids.js";
import { notify } from "../../notification/service/notificationService.js";
import { MIME_BY_EXTENSION, extensionOf } from "../../opportunity/service/leadAttachmentService.js";
import { SITE_PHOTOS_KEY, fieldsToCheck } from "./inspectionForm.js";
import {
    assertAssignable,
    assertReadable,
    isAdmin,
    isAssignee,
    isRequester,
    loadRequest,
    presentRequest,
    recordEvent,
    requestLabel,
} from "./collaborationService.js";
import {
    cleanRequestedDocuments,
    cleanRequestedFields,
    isWellFormedToken,
    newToken,
    presentPublicTask,
    publicPhotoUrl,
    sanitizeSubmission,
} from "./siteVisitShape.js";

const { CollaborationSiteVisit, CollaborationAttachment, CollaborationRequest, Opportunity, Quote } = db;

const httpError = (status, message, errors) => Object.assign(new Error(message), { status, ...(errors ? { errors } : {}) });

/** Photos a form may collect in total — generous for a site, bounded for a leaked link. */
const MAX_PHOTOS_PER_VISIT = 80;

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "heic", "bmp"]);

const oneLine = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

// ---- Staff side -------------------------------------------------------------

/** The people who run the visit: whoever it is assigned to, whoever raised it, or ADM. */
const assertCanManage = (request, user) => {
    if (!isAssignee(request, user) && !isRequester(request, user) && !isAdmin(user))
        throw httpError(403, "Only the people on this assignment can manage its site-visit form");
};

/**
 * Creates the form, or replaces what it asks for while it is still pending.
 * The token — and so the link already handed out — survives a replace.
 *
 * body: { assigneeId? | assigneeName, assigneeEmail?, assigneePhone?,
 *         requestedFields: [{ key, label, kind }],
 *         requestedDocuments: [{ key, label, type, comment }] }
 * → the request, with siteVisit on it.
 */
export const saveSiteVisitTask = async (user, id, payload = {}) => {
    const request = assertReadable(await loadRequest(id), user);
    if (request.kind !== "assignment") throw httpError(400, "Only assignments go out to site");
    if (request.status === "cancelled") throw httpError(400, "This assignment is cancelled");
    assertCanManage(request, user);

    const existing = request.siteVisit ?? null;
    if (existing?.status === "submitted")
        throw httpError(409, "This form has already been submitted — its answers are the record of the visit");

    // Who is attending: someone in the directory, or a name typed in.
    let assignee = { assigneeId: null, assigneeName: null, assigneeEmail: null, assigneePhone: null };
    const wanted = payload.assigneeId;
    if (wanted !== undefined && wanted !== null && wanted !== "") {
        const person = await assertAssignable(wanted, request);
        assignee = { ...assignee, assigneeId: person.id, assigneeName: person.name };
    } else {
        const name = oneLine(payload.assigneeName, 120);
        if (!name) throw httpError(400, "Say who is attending", [{ field: "assigneeName", message: "Enter the name of the person attending." }]);
        const email = oneLine(payload.assigneeEmail, 254).toLowerCase();
        if (email && !EMAIL_RE.test(email))
            throw httpError(400, "Enter a valid email address", [{ field: "assigneeEmail", message: "Enter a valid email address." }]);
        assignee = { ...assignee, assigneeName: name, assigneeEmail: email || null, assigneePhone: oneLine(payload.assigneePhone, 40) || null };
    }

    const requestedFields = cleanRequestedFields(payload.requestedFields);
    const requestedDocuments = cleanRequestedDocuments(payload.requestedDocuments);
    if (!requestedFields.length && !requestedDocuments.length)
        throw httpError(400, "Ask for at least one piece of information or one photo");

    // Read before the update below overwrites it on the same instance.
    const previousAssigneeId = existing?.assigneeId ?? null;

    const values = { ...assignee, requestedFields, requestedDocuments };
    if (existing) await existing.update(values);
    else
        await CollaborationSiteVisit.create({
            ...values,
            requestId: request.id,
            token: newToken(),
            status: "pending",
            createdById: user.id,
        });

    await recordEvent(request, existing ? "Site-visit form updated" : "Site-visit form created", `For ${assignee.assigneeName}`, user);

    // Someone in the directory newly handed the visit hears about it; a typed-in
    // name gets the link from the coordinator directly.
    if (assignee.assigneeId && assignee.assigneeId !== previousAssigneeId)
        await notify({
            event: "site_visit.assigned",
            title: `Site visit: ${request.title}`,
            body: `${user.name} handed you the site visit for ${requestLabel(request)}${request.opportunity?.number ? ` on ${request.opportunity.number}` : ""}. Open the request for the form.`,
            userIds: [assignee.assigneeId],
            businessUnitId: request.businessUnitId,
            opportunity: request.opportunity,
            request,
            actor: user,
        });

    return presentRequest(await loadRequest(request.id), user);
};

/** A duplicate, a blurred shot, the wrong board — the coordinator removes it. → the request. */
export const deleteSiteVisitPhoto = async (user, id, photoId) => {
    const request = assertReadable(await loadRequest(id), user);
    assertCanManage(request, user);

    const photo = await CollaborationAttachment.findOne({
        where: { id: parseId(photoId, "photo id"), requestId: request.id, category: "site_visit" },
    });
    if (!photo) throw httpError(404, "Photo not found");

    await storage.remove(photo.storageKey);
    await photo.destroy();
    await recordEvent(request, "Site-visit photo removed", photo.filename, user);

    return presentRequest(await loadRequest(request.id), user);
};

// ---- Public side ------------------------------------------------------------

// Every failure to find the form reads the same, so a caller cannot tell a
// wrong token from a withdrawn one.
const notFound = () => httpError(404, "This link is not valid, or it has been withdrawn.");

/** The form behind a token, with just enough of the request and job to present it. */
const loadByToken = async (token) => {
    if (!isWellFormedToken(token)) throw notFound();
    const visit = await CollaborationSiteVisit.findOne({ where: { token } });
    if (!visit) throw notFound();
    // Paranoid: a deleted request is gone. A cancelled one withdraws its link.
    const request = await CollaborationRequest.findByPk(visit.requestId, {
        include: [
            {
                model: Opportunity,
                as: "opportunity",
                attributes: [
                    "id",
                    "number",
                    "businessUnitId",
                    "siteLine1",
                    "siteSuburb",
                    "siteState",
                    "sitePostcode",
                    "customerLegalName",
                    "customerTradingName",
                    "customerFirstName",
                    "customerLastName",
                ],
            },
        ],
    });
    if (!request || request.status === "cancelled") throw notFound();
    return { visit, request };
};

const photosOf = (request) =>
    CollaborationAttachment.findAll({
        where: { requestId: request.id, category: "site_visit" },
        order: [["createdAt", "ASC"], ["id", "ASC"]],
    });

/** The public view with the job details the inspection form heads itself with. */
const presentPublic = async (visit, request, photos) => {
    const quote = request.opportunity ? await Quote.findOne({ where: { opportunityId: request.opportunity.id }, attributes: ["quoteNumber"] }) : null;
    return presentPublicTask(visit, request, request.opportunity, photos, { quoteNumber: quote?.quoteNumber ?? null, sitePhotosKey: SITE_PHOTOS_KEY });
};

/** What the person attending has been asked for. */
export const getPublicTask = async (token) => {
    const { visit, request } = await loadByToken(token);
    return presentPublic(visit, request, await photosOf(request));
};

/**
 * body: { name, email?, phone?, fields: { key: answer } }. At least one of
 * email or phone — it is how the coordinator gets back to them. Submitting
 * closes the form and tells the coordinator and the requester.
 */
export const submitPublicTask = async (token, body) => {
    const { visit, request } = await loadByToken(token);
    if (visit.status === "submitted") throw httpError(409, "This form has already been submitted. Thank you.");

    // The whole inspection form (CL-04), with what was asked for required.
    const { clean, errors } = sanitizeSubmission(body, fieldsToCheck(visit.requestedFields), {
        contactRequired: !(visit.assigneeId || visit.assigneeEmail || visit.assigneePhone),
    });
    if (errors.length) throw httpError(400, errors[0].message, errors);
    // Filled in by the form itself, never typed: who signed, and the day it was sent.
    clean.fields.signedBy = clean.name;
    clean.fields.submittedOn = new Date().toISOString().slice(0, 10);

    const submittedAt = new Date();
    await visit.update({ status: "submitted", submittedAt, response: clean });

    const photos = await photosOf(request);
    await recordEvent(
        request,
        "Site-visit form submitted",
        `By ${clean.name}${photos.length ? ` · ${photos.length} photo${photos.length === 1 ? "" : "s"}` : ""}`,
        null
    );
    await notify({
        event: "site_visit.submitted",
        title: `Site-visit form in: ${requestLabel(request)}`,
        body: `${clean.name} submitted the site-visit form for "${request.title}"${request.opportunity?.number ? ` on ${request.opportunity.number}` : ""}.`,
        userIds: [request.assigneeId, request.createdById].filter(Boolean),
        businessUnitId: request.businessUnitId,
        opportunity: request.opportunity,
        request,
    });

    return presentPublic(visit, request, photos);
};

/**
 * One photo or document, uploaded as it is chosen — a site member on mobile
 * data should not lose a dozen photos to one failed request. The file's type
 * comes from its extension, checked against what the slot asked for; what the
 * browser declares is never trusted. → { id, filename, url, documentKey }
 */
export const uploadPublicPhoto = async (token, file, documentKey) => {
    const { visit, request } = await loadByToken(token);
    if (visit.status === "submitted") throw httpError(409, "This form has been submitted — no more files can be added.");
    if (!file) throw httpError(400, 'Attach a file in the "file" field');

    // The inspection form's own "additional site photos" slot is always there;
    // a file sent without a slot goes into it.
    const key = documentKey ? String(documentKey) : SITE_PHOTOS_KEY;
    const slot =
        key === SITE_PHOTOS_KEY
            ? { key: SITE_PHOTOS_KEY, label: "Site photos", type: "image" }
            : (Array.isArray(visit.requestedDocuments) ? visit.requestedDocuments : []).find((doc) => doc.key === key);
    if (!slot) throw httpError(400, "Upload against one of the photos or documents the form asks for");

    const extension = extensionOf(file.originalname);
    const allowed = slot.type === "image" ? IMAGE_EXTENSIONS.has(extension) : Boolean(MIME_BY_EXTENSION[extension]);
    if (!allowed)
        throw httpError(400, slot.type === "image" ? `${slot.label} needs a photo (JPG, PNG, HEIC…)` : `${file.originalname}: file type not allowed`);

    const already = await CollaborationAttachment.count({ where: { requestId: request.id, category: "site_visit" } });
    if (already >= MAX_PHOTOS_PER_VISIT) throw httpError(400, `This form already holds ${MAX_PHOTOS_PER_VISIT} files — that is the most it takes`);

    const safe = path.basename(String(file.originalname || "file")).replace(/[^\w.\-]+/g, "_").slice(0, 80) || "file";
    const storageKey = `collaboration/${request.id}/site-visit/${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${safe}`;
    const mime = MIME_BY_EXTENSION[extension] || "application/octet-stream";
    await storage.put(storageKey, file.buffer, { contentType: mime });

    const photo = await CollaborationAttachment.create({
        requestId: request.id,
        category: "site_visit",
        documentKey: slot.key,
        filename: String(file.originalname).slice(0, 255),
        mime,
        size: file.size,
        storageKey,
        uploaderId: null,
    });

    return { id: photo.id, filename: photo.filename, url: publicPhotoUrl(visit.token, photo.id), documentKey: photo.documentKey };
};

/** Streams one of this form's photos back to the page that uploaded it. */
export const getPublicPhoto = async (token, photoId) => {
    const { request } = await loadByToken(token);
    const photo = await CollaborationAttachment.findOne({
        where: { id: parseId(photoId, "photo id"), requestId: request.id, category: "site_visit" },
    });
    if (!photo) throw httpError(404, "Photo not found");
    return { photo, file: await storage.open(photo.storageKey) };
};
