import logger from "../utils/logger.js";

// Global error middleware — the counterpart of asyncHandler. Services throw
// errors carrying .status (and optionally .errors with field details); those
// are client-facing. Anything without a .status is unexpected: it is logged
// server-side and the client gets a generic message so internals never leak.
export const errorHandler = (err, req, res, next) => {
    if (res.headersSent) return next(err);

    const expected = Boolean(err.status);
    if (!expected) logger.error(`[${req.method} ${req.originalUrl}] ${err.stack ?? err.message}`);

    return res.status(err.status ?? 500).json({
        success: false,
        message: expected ? err.message : "Internal server error",
        ...(err.errors ? { errors: err.errors } : {}),
    });
};

export default errorHandler;
