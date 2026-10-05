import db from "../models/index.js";
import { parseId } from "../utils/ids.js";
import { canAccessUnit } from "../utils/unitScope.js";
import { errorResponse } from "../utils/apiResponse.js";
import { OWNER_FIELDS, assignedUserIds } from "../modules/opportunity/service/opportunityPeople.js";
import { viewPermissionFor } from "../modules/opportunity/service/stageAccess.js";
import { userHasPermission } from "../modules/role/service/roleService.js";

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
 * Whether the caller may see this record at the stage it is in now. The lists
 * narrow to the stages a person may read (stageAccess.readableStages), so
 * opening one record by its id has to ask the same question — otherwise anyone
 * could walk the ids and read stages their role has no business in.
 *
 * Two reasons let one record through even so, because the system itself sent
 * the person there: they are named on it (salesperson, estimator, lead owner,
 * coordinator, delivery owner — "a sales representative follows their own
 * deals"), or they were notified about it — a notification opens the record,
 * and a link the app sent must not answer "not found". Both are only asked
 * when the stage permission is missing; grants are cached, so the usual case
 * costs no query.
 */
const canSeeAtStage = async (user, opportunity) => {
    if (await userHasPermission(user, viewPermissionFor(opportunity.stage))) return true;
    if (assignedUserIds(opportunity).includes(Number(user.id))) return true;
    const notified = await db.Notification.findOne({
        where: { userId: user.id, opportunityId: opportunity.id },
        attributes: ["id"],
    });
    return Boolean(notified);
};

/**
 * For every route addressing one opportunity (/:id/...): answers 404 when the
 * record does not exist, sits outside the caller's units, or sits at a stage
 * the caller may not read (canSeeAtStage) — the same "not found" the user
 * module gives for out-of-scope users, so a caller cannot probe which ids
 * exist or what they hold.
 * Mount once with router.use("/:id", requireOpportunityAccess) so new routes
 * are covered by default.
 */
export const requireOpportunityAccess = async (req, res, next) => {
    try {
        if (!req.user) return errorResponse(res, "Not authenticated", 401);
        const id = parseId(req.params.id, "opportunity id");
        const opportunity = await db.Opportunity.findByPk(id, { attributes: ["id", "businessUnitId", "stage", ...OWNER_FIELDS] });
        if (!opportunity || !canAccessUnit(req.user, opportunity.businessUnitId) || !(await canSeeAtStage(req.user, opportunity)))
            return errorResponse(res, "Opportunity not found", 404);
        req.opportunityUnitId = opportunity.businessUnitId;
        return next();
    } catch (err) {
        return next(err);
    }
};

export default requireUnitAccess;
