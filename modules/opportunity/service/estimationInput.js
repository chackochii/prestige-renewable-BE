// The optional lead-checklist rows, carried on the opportunity as one object.
//
// Sales fills in what they can while capturing the lead; estimation collects
// whatever is still blank straight from the client. Both write into the same
// object, so it is merged on every write, never replaced wholesale.
import { ESTIMATION_INPUT_KEYS } from "../model/opportunity.js";

const httpError = (status, message) => Object.assign(new Error(message), { status });
const toBool = (value) => value === true || value === 1 || value === "true" || value === "1";

/**
 * Only known keys survive; `permits` stays a list, the two flags stay
 * booleans, everything else is a capped string. Anything the client invents
 * is dropped rather than stored.
 */
export const sanitizeEstimationInput = (value) => {
    if (value === null || value === undefined) return {};
    if (typeof value !== "object" || Array.isArray(value)) throw httpError(400, "estimationInput must be an object");
    const clean = {};
    for (const key of ESTIMATION_INPUT_KEYS) {
        const given = value[key];
        if (given === undefined) continue;
        if (key === "permits") clean[key] = (Array.isArray(given) ? given : []).map((p) => String(p).slice(0, 40));
        else if (key === "siteVisitCompleted" || key === "vppDiscussed") clean[key] = toBool(given);
        else clean[key] = String(given ?? "").slice(0, 5000);
    }
    return clean;
};

export default sanitizeEstimationInput;
