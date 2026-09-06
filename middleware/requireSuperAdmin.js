import { SUPER_ROLE_CODE } from "../modules/role/service/roleService.js";
import { errorResponse } from "../utils/apiResponse.js";

// Superadmin-only gate. Unlike requirePermission, this can never be granted
// to another role through the permission editor — it is strictly "holds ADM".
// Use it for platform lifecycle actions (creating/removing business units)
// that must stay out of reach of every delegated role.
export const requireSuperAdmin = (req, res, next) => {
    if (!req.user) return errorResponse(res, "Not authenticated", 401);
    const roles = Array.isArray(req.user.roles) ? req.user.roles : [];
    if (!roles.includes(SUPER_ROLE_CODE))
        return errorResponse(res, "Requires the system administrator role", 403);
    return next();
};

export default requireSuperAdmin;
