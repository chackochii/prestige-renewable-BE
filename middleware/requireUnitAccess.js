import db from "../models/index.js";
import { parseId } from "../utils/ids.js";
import { canAccessUnit } from "../utils/unitScope.js";
import { errorResponse } from "../utils/apiResponse.js";

// Business-unit guards. Both expect tokenValidator upstream (req.user with
// businessUnitIds) and let ADM through everywhere — see utils/unitScope.

/**
 * For routes that name the unit explicitly (list filters, create payloads):
 *   router.get("/", requireUnitAccess((req) => req.query.businessUnitId), getAll)
 * 403 when the unit is outside the caller's assignments. A missing/invalid id
 * is left for the service to reject with its usual 400.
 */
export const requireUnitAccess = (pickUnitId) => (req, res, next) => {
    if (!req.user) return errorResponse(res, "Not authenticated", 401);
    const raw = pickUnitId(req);
    if (raw === undefined || raw === null || raw === "") return next();
    const unitId = Number(raw);
    if (!Number.isInteger(unitId) || unitId <= 0) return next();
    if (!canAccessUnit(req.user, unitId))
        return errorResponse(res, "This business unit is outside your assignments", 403);
    return next();
};

/**
 * For every route addressing one opportunity (/:id/...): resolves the record's
 * unit and answers 404 when it does not exist or sits outside the caller's
 * units — the same "not found" the user module gives for out-of-scope users,
 * so a scoped caller cannot probe which ids exist elsewhere.
 * Mount once with router.use("/:id", requireOpportunityAccess) so new routes
 * are covered by default.
 */
export const requireOpportunityAccess = async (req, res, next) => {
    try {
        if (!req.user) return errorResponse(res, "Not authenticated", 401);
        const id = parseId(req.params.id, "opportunity id");
        const opportunity = await db.Opportunity.findByPk(id, { attributes: ["id", "businessUnitId"] });
        if (!opportunity || !canAccessUnit(req.user, opportunity.businessUnitId))
            return errorResponse(res, "Opportunity not found", 404);
        req.opportunityUnitId = opportunity.businessUnitId;
        return next();
    } catch (err) {
        return next(err);
    }
};

export default requireUnitAccess;
