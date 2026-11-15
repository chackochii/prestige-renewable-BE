// Small helpers the equipment, supplier and credit services share.
import { oneLine, multiLine } from "../../../utils/text.js";

export const httpError = (status, message) => Object.assign(new Error(message), { status });

export const isBlank = (value) => value === undefined || value === null || String(value).trim() === "";

/** A required one-line text field. */
export const requiredText = (value, label, max) => {
    const text = oneLine(value, max + 1);
    if (!text) throw httpError(400, `${label} is required`);
    if (text.length > max) throw httpError(400, `${label} must be at most ${max} characters`);
    return text;
};

/** An optional one-line text field: null when blank. */
export const optionalText = (value, label, max) => {
    if (isBlank(value)) return null;
    if (typeof value !== "string" && typeof value !== "number") throw httpError(400, `${label} must be text`);
    const text = oneLine(value, max + 1);
    if (text.length > max) throw httpError(400, `${label} must be at most ${max} characters`);
    return text || null;
};

export const optionalLongText = (value, label, max) => {
    if (isBlank(value)) return null;
    if (typeof value !== "string") throw httpError(400, `${label} must be text`);
    const text = multiLine(value, max + 1);
    if (text.length > max) throw httpError(400, `${label} must be at most ${max} characters`);
    return text || null;
};

/** A money amount: a finite number, to the cent. `min` defaults to 0. */
export const money = (value, label, { min = 0, allowNull = false } = {}) => {
    if (isBlank(value)) {
        if (allowNull) return null;
        throw httpError(400, `${label} is required`);
    }
    const amount = Number(value);
    if (!Number.isFinite(amount)) throw httpError(400, `${label} must be a number`);
    if (amount < min) throw httpError(400, `${label} must be ${min} or more`);
    return Math.round(amount * 100) / 100;
};

export const wholeNumber = (value, label, { min = 0, allowNull = false } = {}) => {
    if (isBlank(value)) {
        if (allowNull) return null;
        throw httpError(400, `${label} is required`);
    }
    const n = Number(value);
    if (!Number.isInteger(n)) throw httpError(400, `${label} must be a whole number`);
    if (n < min) throw httpError(400, `${label} must be ${min} or more`);
    return n;
};

/** A calendar date as YYYY-MM-DD, or null when blank and allowed. */
export const dateOnly = (value, label, { allowNull = true } = {}) => {
    if (isBlank(value)) {
        if (allowNull) return null;
        throw httpError(400, `${label} is required`);
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw httpError(400, `${label} must be a date`);
    return date.toISOString().slice(0, 10);
};

export const oneOf = (value, options, label) => {
    const v = String(value ?? "").trim();
    if (!options.includes(v)) throw httpError(400, `${label} must be one of: ${options.join(", ")}`);
    return v;
};

export const round2 = (n) => Math.round(Number(n) * 100) / 100;

/** Today as YYYY-MM-DD. */
export const today = () => new Date().toISOString().slice(0, 10);

/** The next code in a series: prefix + zero-padded number past the highest existing one. */
export const nextCode = (prefix, existingCodes, width = 3) => {
    const highest = existingCodes
        .map((code) => (String(code ?? "").startsWith(prefix) ? Number(String(code).slice(prefix.length)) : NaN))
        .filter((n) => Number.isInteger(n) && n > 0)
        .reduce((max, n) => Math.max(max, n), 0);
    return `${prefix}${String(highest + 1).padStart(width, "0")}`;
};

export const userBrief = (user) => (user ? { id: user.id, name: user.name } : null);
