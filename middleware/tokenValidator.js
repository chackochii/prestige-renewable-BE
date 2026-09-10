import db from "../models/index.js";
import { verifyToken } from "../utils/jwt.js";
import { errorResponse } from "../utils/apiResponse.js";

// Token middleware. Verifies the "Authorization: Bearer <jwt>" header, loads
// the user fresh from the database and sets req.user for the downstream
// guards (roleValidator / requirePermission). The DB read means disabled or
// deleted users are cut off immediately, not when their token expires.
export const tokenValidator = async (req, res, next) => {
    try {
        const [scheme, token] = (req.headers.authorization ?? "").split(" ");
        if (scheme !== "Bearer" || !token)
            return errorResponse(res, "Missing bearer token", 401);

        let payload;
        try {
            payload = verifyToken(token);
        } catch {
            return errorResponse(res, "Invalid or expired token", 401);
        }

        // Scoped tokens (e.g. document download links) only work on the route
        // that declared the matching scope — see tokenFromQuery.
        if (payload.scope && payload.scope !== req.tokenScope)
            return errorResponse(res, "This token cannot be used for this request", 401);
        req.tokenPayload = payload;

        // Default scope excludes the password hash; paranoid excludes soft-deleted.
        const user = await db.User.findByPk(payload.sub);
        if (!user) return errorResponse(res, "User no longer exists", 401);
        if (user.status !== "active")
            return errorResponse(res, "Account is disabled", 401);

        req.user = user;
        return next();
    } catch (err) {
        return next(err);
    }
};

export default tokenValidator;
