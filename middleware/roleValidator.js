import { SUPER_ROLE_CODE } from "../modules/role/service/roleService.js";
import { errorResponse } from "../utils/apiResponse.js";

// Guards a route with role codes — the user needs at least one of them:
//   router.post("/", tokenValidator, roleValidator("DIR", "BDM"), handler)
// ADM always passes (same break-glass as requirePermission). Prefer
// requirePermission for feature access; use this only where a rule is
// genuinely about the role itself rather than a grantable capability.
export const roleValidator = (...allowedRoles) => (req, res, next) => {
    if (!req.user) return errorResponse(res, "Not authenticated", 401);

    const roles = Array.isArray(req.user.roles) ? req.user.roles : [];
    if (roles.includes(SUPER_ROLE_CODE) || allowedRoles.some((code) => roles.includes(code)))
        return next();

    return errorResponse(res, `Requires one of roles: ${allowedRoles.join(", ")}`, 403);
};

export default roleValidator;
