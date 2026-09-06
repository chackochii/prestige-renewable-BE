// Error responses sent directly by middleware guards (tokenValidator,
// roleValidator, requirePermission). Same shape as the global errorHandler:
//   { success: false, message, errors? }
export const errorResponse = (res, message, statusCode = 500, errors = null) =>
    res.status(statusCode).json({
        success: false,
        message: message || "Internal server error",
        ...(errors ? { errors } : {}),
    });
