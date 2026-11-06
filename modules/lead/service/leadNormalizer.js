// Turns a platform's answers into the contact columns of inbound_leads.
//
// Each platform hands over a list of { key, label, value } — Meta's field_data
// names, Google's column ids — and this maps the ones it recognises
// (full name, email, phone, suburb, postcode, …) onto our columns. Anything
// it does not recognise is kept as an extra and written into the message as
// "Label: answer" lines, so a custom question ("What is your roof type?") is
// never lost even though it has no column. A connection can steer the mapping
// with config.fieldMap: { "<form field key>": "<column>" | "ignore" }.
import { oneLine, multiLine } from "../../../utils/text.js";

/** Columns a form field can be mapped to (config.fieldMap values). */
export const MAPPABLE_COLUMNS = [
    "name", "firstName", "lastName", "email", "phone", "company",
    "street", "suburb", "state", "postcode", "message", "ignore",
];

// Field keys the platforms and common form builders use, by column. Keys are
// compared after lower-casing and dropping everything but letters and digits,
// so "Full Name", "full_name" and "FULL_NAME" all read the same.
const ALIASES = {
    name: ["fullname", "name", "yourname", "contactname", "customername"],
    firstName: ["firstname", "givenname", "forename"],
    lastName: ["lastname", "surname", "familyname"],
    email: ["email", "emailaddress", "useremail", "workemail", "youremail"],
    phone: ["phone", "phonenumber", "mobile", "mobilenumber", "userphone", "workphone", "telephone", "contactnumber", "yourphone"],
    company: ["company", "companyname", "business", "businessname", "organisation", "organization"],
    street: ["streetaddress", "address", "street", "addressline1", "siteaddress"],
    suburb: ["suburb", "city", "town", "locality"],
    state: ["state", "region", "province"],
    postcode: ["postcode", "postalcode", "zipcode", "zip"],
    message: ["message", "comments", "comment", "enquiry", "inquiry", "notes", "description", "howcanwehelp", "yourmessage"],
};

const LIMITS = {
    name: 255, firstName: 100, lastName: 100, email: 254, phone: 30, company: 255,
    street: 200, suburb: 100, state: 10, postcode: 10, message: 4000,
};

const AU_STATES = ["NSW", "ACT", "VIC", "QLD", "SA", "WA", "TAS", "NT"];
const STATE_NAMES = {
    "NEW SOUTH WALES": "NSW",
    "AUSTRALIAN CAPITAL TERRITORY": "ACT",
    VICTORIA: "VIC",
    QUEENSLAND: "QLD",
    "SOUTH AUSTRALIA": "SA",
    "WESTERN AUSTRALIA": "WA",
    TASMANIA: "TAS",
    "NORTHERN TERRITORY": "NT",
};

export const normalizeKey = (key) => String(key ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

const columnFor = (key, fieldMap) => {
    const normalized = normalizeKey(key);
    if (!normalized) return null;
    // The connection's own mapping first — written for the form's exact keys.
    for (const [mapKey, column] of Object.entries(fieldMap ?? {}))
        if (normalizeKey(mapKey) === normalized && MAPPABLE_COLUMNS.includes(column)) return column;
    for (const [column, aliases] of Object.entries(ALIASES)) if (aliases.includes(normalized)) return column;
    return null;
};

/** The phone as stored: digits with one optional leading "+", spaces and punctuation gone. */
export const cleanPhone = (value) => {
    const text = oneLine(value, 60);
    if (!text) return "";
    const plus = text.startsWith("+") ? "+" : "";
    const digits = text.replace(/\D/g, "");
    return digits ? `${plus}${digits}`.slice(0, LIMITS.phone) : "";
};

/** The last nine digits — the part of an Australian number that is the same with or without +61. */
export const phoneKey = (value) => {
    const digits = String(value ?? "").replace(/\D/g, "");
    return digits.length >= 8 ? digits.slice(-9) : "";
};

export const cleanEmail = (value) => {
    const text = oneLine(value, LIMITS.email).toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? text : "";
};

const cleanState = (value) => {
    const text = oneLine(value, 40).toUpperCase();
    if (AU_STATES.includes(text)) return text;
    return STATE_NAMES[text] ?? text.slice(0, LIMITS.state);
};

const joinValues = (value) =>
    Array.isArray(value) ? value.filter((v) => v !== null && v !== undefined && v !== "").join(", ") : value;

/**
 * fields: [{ key, label?, value }] as the platform reports them.
 * → { name, firstName, lastName, email, phone, company, street, suburb,
 *     state, postcode, message, extras: [{ label, value }] }
 * Every value is cleaned (utils/text) and length-capped; blanks are "".
 */
export const normalizeFields = (fields = [], { fieldMap = null } = {}) => {
    const out = {
        name: "", firstName: "", lastName: "", email: "", phone: "", company: "",
        street: "", suburb: "", state: "", postcode: "", message: "",
    };
    const extras = [];
    const asExtra = (field, raw) => {
        const value = oneLine(raw, 500);
        if (value) extras.push({ label: oneLine(field?.label ?? field?.key ?? "Answer", 120), value });
    };

    for (const field of Array.isArray(fields) ? fields : []) {
        const raw = joinValues(field?.value);
        const column = columnFor(field?.key, fieldMap);
        if (column === "ignore") continue;
        if (column === "message") {
            const text = multiLine(raw, LIMITS.message);
            if (text) out.message = out.message ? `${out.message}\n\n${text}` : text;
            continue;
        }
        if (!column) {
            asExtra(field, raw);
            continue;
        }
        const value =
            column === "email" ? cleanEmail(raw)
            : column === "phone" ? cleanPhone(raw)
            : column === "state" ? cleanState(raw)
            : oneLine(raw, LIMITS[column]);
        if (!value) continue;
        // A second answer for a column already filled (two phone fields, say) is kept as an extra.
        if (out[column]) asExtra(field, raw);
        else out[column] = value;
    }

    if (!out.name) out.name = [out.firstName, out.lastName].filter(Boolean).join(" ").slice(0, LIMITS.name);
    if (out.postcode && !/^\d{4}$/.test(out.postcode)) {
        // Not an Australian postcode as the site fields store it: keep it readable instead.
        extras.unshift({ label: "Postcode", value: out.postcode });
        out.postcode = "";
    }

    // Unmapped answers go into the message so the reviewer reads them with the lead.
    if (extras.length) {
        const lines = extras.map((extra) => `${extra.label}: ${extra.value}`).join("\n");
        out.message = multiLine(out.message ? `${out.message}\n\n${lines}` : lines, LIMITS.message);
    }
    return { ...out, extras };
};

/** What the reviewer sees as the lead's name when the form had none. */
export const displayName = (normalized) =>
    normalized?.name || normalized?.company || normalized?.email || normalized?.phone || "Unnamed lead";
