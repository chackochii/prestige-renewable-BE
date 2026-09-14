// Unauthenticated endpoint for the website enquiry form. No tokenValidator
// on purpose — keep this file to what the public form needs and nothing else.
// Defences, in order: body-size cap, per-IP rate limit, then strict field
// validation in publicLeadService.
//
// There is deliberately no public route that lists business units: visitors
// never choose one, so the unit names are not exposed to anonymous callers.
import { Router } from "express";
import { createFromPublicForm } from "../modules/opportunity/controller/publicLeadController.js";
import rateLimit from "../middleware/rateLimit.js";
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

export default router;
