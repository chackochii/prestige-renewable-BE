// Success responses sent by controllers:
//   { success: true, data?, message?, ...meta }
// The payload is spread as-is, so list endpoints can add pagination
// (total, page, pageSize) and login can return { token, user } directly.
export const successResponse = (res, payload = {}, statusCode = 200) =>
    res.status(statusCode).json({ success: true, ...payload });

// Error responses sent directly by middleware guards (tokenValidator,
// roleValidator, requirePermission). Same shape as the global errorHandler:
//   { success: false, message, errors? }
export const errorResponse = (res, message, statusCode = 500, errors = null) =>
    res.status(statusCode).json({
        success: false,
        message: message || "Internal server error",
        ...(errors ? { errors } : {}),
    });
