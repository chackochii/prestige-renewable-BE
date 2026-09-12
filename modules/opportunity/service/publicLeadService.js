// Website enquiry form: anyone can submit a lead without signing in. The
// public surface is deliberately narrow — a fixed set of fields, strict
// per-field validation, and a minimal response — and everything else
// (numbering, SLA, qualification defaults) still goes through createLead so
// a public lead is a normal stage-1 opportunity for the team.
//
// Threat model for an unauthenticated write: junk or oversized input, script
// and control characters landing in the record, spam floods, double submits,
// and posting into a unit that should not take enquiries. Each is handled
// here or in routes/publicRoutes.js (body-size cap, rate limit).
import { Op } from "sequelize";
import db from "../../../models/index.js";
import { createLead } from "./opportunityService.js";
import { notifyBusinessOwner } from "./leadWorkflowService.js";
import logger from "../../../utils/logger.js";

const { BusinessUnit, Opportunity } = db;

const httpError = (status, message, errors) => Object.assign(new Error(message), { status, errors });

/** What the form labels the lead source as on the record. */
export const PUBLIC_LEAD_SOURCE_DETAILS = "Website enquiry form";

/** Units that accept public enquiries. `inactive` units never do. */
const ACCEPTING_STATUSES = ["active", "configured"];

/** A repeat submit from the same email to the same unit inside this window returns the first lead. */
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

export const AU_STATES = ["NSW", "ACT", "VIC", "QLD", "SA", "WA", "TAS", "NT"];

// ---- Field rules -----------------------------------------------------------
// Every field has a max length and an allowed-character pattern; the three
// required ones also have a non-empty check. Letter classes are Unicode-aware
// so accented names pass, while angle brackets, quotes, backslashes and
// control characters never reach the database.
const RULES = {
    name: { max: 100, min: 2, pattern: /^[\p{L}\p{M}][\p{L}\p{M}\s'.-]*$/u },
    email: { max: 254, pattern: /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/ },
    phone: { max: 30, pattern: /^\+?[\d\s().-]+$/, minDigits: 8, maxDigits: 15 },
    siteLine1: { max: 200, pattern: /^[\p{L}\p{M}\p{N}\s,.'#/-]*$/u },
    siteSuburb: { max: 100, pattern: /^[\p{L}\p{M}\s'.-]*$/u },
    siteState: { max: 3 },
    sitePostcode: { max: 4, pattern: /^\d{4}$/ },
    message: { max: 2000 },
    businessUnit: { max: 10, pattern: /^[A-Z0-9]{2,10}$/ },
};

// C0 and C1 control characters, zero-width/bidi characters, and the BOM.
// Single-line fields replace these with a space; the message drops them but
// keeps its own newlines (handled separately below).
const CONTROL_CLASS = "\\u0000-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u2028\\u2029\\u202A-\\u202E\\u2060\\uFEFF";
const CONTROL_RE = new RegExp(`[${CONTROL_CLASS}]`, "g");
const MESSAGE_CONTROL_RE = new RegExp(`[${CONTROL_CLASS.replace("\\u0000-\\u001F", "\\u0000-\\u0009\\u000B\\u000C\\u000E-\\u001F")}]`, "g");

// Single-line field: strip controls, collapse whitespace runs, trim. Length
// is NOT capped here — an over-long value is rejected rather than silently
// truncated, so "20000" never becomes a valid-looking "2000". The hard slice
// below only stops a megabyte of junk being carried around in memory.
const HARD_CAP = 4000;
const clean = (value) => {
    if (typeof value !== "string") return "";
    return value.slice(0, HARD_CAP).replace(CONTROL_RE, " ").replace(/\s+/g, " ").trim();
};

/** The message keeps paragraph breaks; everything else is normalised. */
const cleanMessage = (value) => {
    if (typeof value !== "string") return "";
    return value
        .replace(MESSAGE_CONTROL_RE, "")
        .replace(/\r\n?/g, "\n")
        .replace(/[^\S\n]+/g, " ") // collapse spaces and tabs, keep newlines
        .replace(/ *\n */g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .slice(0, RULES.message.max);
};

const countDigits = (value) => (value.match(/\d/g) || []).length;

/**
 * Validates and normalises the public payload. Returns
 * { fields, errors, honeypot }, where errors is [{ field, message }] listing
 * every problem at once so the form can highlight them all in one round trip.
 */
export const validatePublicLead = (body) => {
    const src = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    const errors = [];
    const fail = (field, message) => errors.push({ field, message });
    const tooLong = (field, value, label) => {
        if (value.length > RULES[field].max) {
            fail(field, `Your ${label} is too long (${RULES[field].max} characters max).`);
            return true;
        }
        return false;
    };

    // --- Required: name, email, phone ---
    const name = clean(src.name);
    if (!name) fail("name", "Enter your name.");
    else if (name.length < RULES.name.min) fail("name", "Enter your full name.");
    else if (!tooLong("name", name, "name") && !RULES.name.pattern.test(name))
        fail("name", "Your name can only contain letters, spaces, apostrophes and hyphens.");

    const email = clean(src.email).toLowerCase();
    if (!email) fail("email", "Enter your email.");
    else if (!tooLong("email", email, "email") && !RULES.email.pattern.test(email))
        fail("email", "Enter a valid email address.");

    const phone = clean(src.phone);
    if (!phone) fail("phone", "Enter your phone number.");
    else if (!tooLong("phone", phone, "phone number")) {
        if (!RULES.phone.pattern.test(phone))
            fail("phone", "A phone number can only contain digits, spaces and + ( ) - characters.");
        else {
            const digits = countDigits(phone);
            if (digits < RULES.phone.minDigits || digits > RULES.phone.maxDigits)
                fail("phone", `Enter a valid phone number (${RULES.phone.minDigits} to ${RULES.phone.maxDigits} digits).`);
        }
    }

    // --- Optional: site address and message ---
    const siteLine1 = clean(src.siteLine1);
    if (siteLine1 && !tooLong("siteLine1", siteLine1, "street address") && !RULES.siteLine1.pattern.test(siteLine1))
        fail("siteLine1", "The street address contains characters we can't accept.");

    const siteSuburb = clean(src.siteSuburb);
    if (siteSuburb && !tooLong("siteSuburb", siteSuburb, "suburb") && !RULES.siteSuburb.pattern.test(siteSuburb))
        fail("siteSuburb", "The suburb contains characters we can't accept.");

    const siteState = clean(src.siteState).toUpperCase();
    if (siteState && !AU_STATES.includes(siteState)) fail("siteState", "Choose a state from the list.");

    const sitePostcode = clean(src.sitePostcode);
    if (sitePostcode && !RULES.sitePostcode.pattern.test(sitePostcode)) fail("sitePostcode", "Postcode must be 4 digits.");

    const message = cleanMessage(src.message);

    // Comes from the link, not the form, so a bad value means a broken link.
    const businessUnit = clean(src.businessUnit).toUpperCase();
    if (businessUnit && !RULES.businessUnit.pattern.test(businessUnit))
        fail("businessUnit", "This enquiry link is not valid. Please use the link you were given, or contact us directly.");

    return {
        errors,
        honeypot: typeof src.website === "string" && src.website.trim() !== "",
        fields: { name, email, phone, siteLine1, siteSuburb, siteState, sitePostcode, message, businessUnit },
    };
};

// Which unit the lead lands in. Visitors never pick: the code comes from the
// link staff shared (?unit=PRS), else PUBLIC_LEAD_UNIT_CODE, else the first
// accepting unit by code. An unknown or inactive code is rejected rather than
// quietly falling back, so a stale link is noticed instead of misfiling leads.
const resolveUnit = async (code) => {
    const wanted = code || String(process.env.PUBLIC_LEAD_UNIT_CODE || "").trim().toUpperCase();
    if (wanted) {
        const unit = await BusinessUnit.findOne({ where: { code: wanted, status: ACCEPTING_STATUSES } });
        if (!unit) {
            const message = "This enquiry link is not valid. Please use the link you were given, or contact us directly.";
            throw httpError(400, message, [{ field: "businessUnit", message }]);
        }
        return unit;
    }
    const unit = await BusinessUnit.findOne({ where: { status: ACCEPTING_STATUSES }, order: [["code", "ASC"]] });
    if (!unit) throw httpError(503, "No business unit is accepting enquiries yet.");
    return unit;
};

// The same person re-sending the form (double click, refresh, retry after a
// network blip) should not create a second lead.
const findRecentDuplicate = (unit, email) =>
    Opportunity.findOne({
        where: {
            businessUnitId: unit.id,
            customerEmail: email,
            leadSourceDetails: PUBLIC_LEAD_SOURCE_DETAILS,
            createdAt: { [Op.gte]: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
        },
        order: [["createdAt", "DESC"]],
        attributes: ["id", "number"],
    });

/**
 * body: { name, email, phone (required); siteLine1?, siteSuburb?, siteState?,
 * sitePostcode?, message?, businessUnit? (code), website? (honeypot) }
 * → { number, businessUnit }
 */
export const createPublicLead = async (body = {}) => {
    const { errors, honeypot, fields } = validatePublicLead(body);
    // Bots fill every input; humans never see the honeypot. Pretend it worked.
    if (honeypot) return { number: null, businessUnit: null };
    if (errors.length) throw httpError(400, errors[0].message, errors);

    const unit = await resolveUnit(fields.businessUnit);

    const duplicate = await findRecentDuplicate(unit, fields.email);
    if (duplicate) return { number: duplicate.number, businessUnit: unit.code, duplicate: true };

    const opportunity = await createLead(
        {
            businessUnitId: unit.id,
            customerLegalName: fields.name,
            customerEmail: fields.email,
            customerPhone: fields.phone,
            contactName: fields.name,
            contactEmail: fields.email,
            contactPhone: fields.phone,
            siteLine1: fields.siteLine1 || null,
            siteSuburb: fields.siteSuburb || null,
            siteState: fields.siteState || null,
            sitePostcode: fields.sitePostcode || null,
            leadSource: "inbound",
            leadSourceDetails: PUBLIC_LEAD_SOURCE_DETAILS,
            notes: fields.message || null,
        },
        null
    );

    // Best effort: the lead exists either way, a failed notification only logs.
    try {
        await notifyBusinessOwner(opportunity.id, null);
    } catch (err) {
        logger.warn(`Public lead ${opportunity.number}: business owner notification failed — ${err.message}`);
    }

    return { number: opportunity.number, businessUnit: unit.code };
};
