import { userHasPermission } from "../modules/role/service/roleService.js";
import { errorResponse } from "../utils/apiResponse.js";

// Guards a route with a permission code:
//   router.patch("/:id/pricing", requirePermission("pricing.edit"), handler)
// Expects an upstream auth middleware to have set req.user with a roles array;
// until one exists every guarded route responds 401.
export const requirePermission = (permissionCode) => async (req, res, next) => {
    try {
        if (!req.user) return errorResponse(res, "Not authenticated", 401);
        if (!(await userHasPermission(req.user, permissionCode)))
            return errorResponse(res, `Missing permission: ${permissionCode}`, 403);
        return next();
    } catch (err) {
        return next(err);
    }
};

export default requirePermission;
