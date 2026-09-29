// Unauthenticated endpoint for the website enquiry form. No tokenValidator
// on purpose — keep this file to what the public form needs and nothing else.
// Defences, in order: body-size cap, per-IP rate limit, then strict field
// validation in publicLeadService.
//
// There is deliberately no public route that lists business units: visitors
// never choose one, so the unit names are not exposed to anonymous callers.
import { Router } from "express";
import { createFromPublicForm } from "../modules/opportunity/controller/publicLeadController.js";
import * as siteVisit from "../modules/collaboration/controller/publicSiteVisitController.js";
import * as proposal from "../modules/opportunity/controller/proposalController.js";
import rateLimit from "../middleware/rateLimit.js";
import { uploadSingleFile } from "../middleware/upload.js";
import { errorResponse } from "../utils/apiResponse.js";

const router = Router();

// The form payload is a few hundred bytes; anything larger is not a person.
// (express.json has already parsed the body at app level, so this checks the
// declared size rather than re-parsing.)
const MAX_BODY_BYTES = 8 * 1024;
const bodySizeGuard = (req, res, next) => {
    const declared = Number(req.headers["content-length"] || 0);
    if (declared > MAX_BODY_BYTES) return errorResponse(res, "Request is too large.", 413);
    if (req.body && (typeof req.body !== "object" || Array.isArray(req.body)))
        return errorResponse(res, "Send a JSON object.", 400);
    return next();
};

router.post(
    "/leads",
    bodySizeGuard,
    rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }),
    createFromPublicForm
); // { name, email, phone, siteLine1?, siteSuburb?, siteState?, sitePostcode?, message?, businessUnit? } → { number, businessUnit }

// ---- Site-visit form --------------------------------------------------------
// The link a coordinator hands to whoever attends a visit. The token in the
// path is the caller's whole authority: one form, nothing else, and never
// the customer or the job (see siteVisitShape.presentPublicTask).
//
// Writes are limited per token rather than per address — a crew on one site
// shares a mobile gateway, while a leaked link is bounded on its own.
const perToken = (req) => `site-visit:${req.params.token}`;
const siteVisitRead = rateLimit({ windowMs: 15 * 60 * 1000, max: 300 });
const siteVisitUpload = rateLimit({ windowMs: 15 * 60 * 1000, max: 120, key: perToken, message: "Too many uploads on this form — wait a few minutes." });
const siteVisitSubmit = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, key: perToken });

router.get("/site-visits/:token", siteVisitRead, siteVisit.getTask); // → { status, title, siteAddress, requestedFields, requestedDocuments, photos, … }
router.post("/site-visits/:token", siteVisitSubmit, siteVisit.submitTask); // { name, email?, phone?, fields } → the task, now submitted
// Limited before multer, so a flood is refused before it is parsed.
router.post("/site-visits/:token/photos", siteVisitUpload, uploadSingleFile, siteVisit.uploadPhoto); // multipart: file + documentKey → { id, filename, url, documentKey }
router.get("/site-visits/:token/photos/:photoId", siteVisitRead, siteVisit.downloadPhoto);

// ---- Proposal link ----------------------------------------------------------
// The link in the customer's proposal email. The token is the whole authority:
// one proposal, and only what the customer needs to read and answer it. Answers
// are limited per token — a customer answers once; the limit only bounds
// someone hammering a leaked link.
const proposalRead = rateLimit({ windowMs: 15 * 60 * 1000, max: 300 });
const proposalRespond = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, key: (req) => `proposal:${req.params.token}` });

router.get("/proposals/:token", proposalRead, proposal.getPublic); // → { state, number, business, contact, grandTotal, quoteVersion: { snapshot }, response, … }
router.post("/proposals/:token/respond", bodySizeGuard, proposalRespond, proposal.respondPublic); // { decision: accept|reject|renegotiate, name, note?, agree? } → the same, answered

export default router;
