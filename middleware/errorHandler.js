import logger from "../utils/logger.js";
import { redactUrl } from "../utils/redact.js";

// Postgres SQLSTATE codes for errors caused by the request's data rather than
// by the server — a value that does not fit the column, a bad enum/number/date
// literal, a NOT NULL or CHECK rule. These bypass Sequelize's model validation
// (e.g. a 300-character string into an unvalidated STRING(255) column) and
// otherwise arrive as a bare SequelizeDatabaseError.
const CLIENT_DATA_CODES = {
    22001: "A value is too long for its field",
    22003: "A numeric value is out of range",
    22007: "A date/time value is malformed",
    22008: "A date/time value is out of range",
    "22P02": "A value has the wrong format for its field",
    23502: "A required field is missing",
    23514: "A value violates a data rule",
};

const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

// Turns Sequelize/DB failures caused by the request into client errors with a
// status; everything else is returned unchanged and treated as unexpected.
export const translateError = (err) => {
    if (!err || err.status) return err;

    if (err.name === "SequelizeValidationError") {
        const errors = err.errors?.map((e) => ({ field: e.path, message: e.message })) ?? null;
        return httpError(400, errors?.[0]?.message ?? "Validation failed", { errors, cause: err });
    }
    if (err.name === "SequelizeUniqueConstraintError") {
        const errors = err.errors?.map((e) => ({ field: e.path, message: e.message })) ?? null;
        return httpError(409, errors?.[0]?.message ?? "A record with these values already exists", {
            errors,
            cause: err,
        });
    }
    if (err.name === "SequelizeForeignKeyConstraintError") {
        const fields = Array.isArray(err.fields) ? err.fields : err.fields ? Object.keys(err.fields) : [];
        const message = fields.length
            ? `${fields.join(", ")} refers to a record that does not exist or is still in use`
            : "The request refers to a record that does not exist or is still in use";
        return httpError(400, message, { errors: fields.map((field) => ({ field, message })), cause: err });
    }
    if (err.name === "SequelizeDatabaseError") {
        const code = err.original?.code ?? err.parent?.code;
        const message = CLIENT_DATA_CODES[code];
        if (message) {
            // Postgres names the column for NOT NULL/CHECK failures; for length
            // and format errors it only describes the type ("character varying(255)").
            const field = err.original?.column ?? err.parent?.column ?? null;
            const detail = field ? `${message}: ${field}` : message;
            return httpError(400, detail, { errors: field ? [{ field, message }] : null, cause: err });
        }
    }
    return err;
};

// Global error middleware — the counterpart of asyncHandler. Services throw
// errors carrying .status (and optionally .errors with field details); those
// are client-facing. Model validation and data-shape failures from Sequelize
// are translated into the same shape here so no service has to. Anything
// still without a .status is unexpected: it is logged server-side and the
// client gets a generic message so internals never leak.
export const errorHandler = (err, req, res, next) => {
    if (res.headersSent) return next(err);

    err = translateError(err);
    const expected = Boolean(err.status);
    if (!expected) logger.error(`[${req.method} ${redactUrl(req.originalUrl)}] ${err.stack ?? err.message}`);

    return res.status(err.status ?? 500).json({
        success: false,
        message: expected ? err.message : "Internal server error",
        ...(err.errors ? { errors: err.errors } : {}),
    });
};

export default errorHandler;
