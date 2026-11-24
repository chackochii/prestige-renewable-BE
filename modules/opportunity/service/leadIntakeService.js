// Lead creation with assignment in one step — the Lead Management rules:
//
//   mandatory: first name, last name, address, phone number, email address
//   assigned:  to a sales representative, recorded in the assignment trail
//   checked:   against the unit's active leads by phone and email (never just
//              the name), so two representatives do not contact the same
//              customer — refused with the existing lead and its representative
//
// POST /api/opportunities/intake. The older POST /api/opportunities keeps its
// own (looser) rules so the current lead form works unchanged; both run the
// same duplicate check and assignment trail.
import { oneLine } from "../../../utils/text.js";
import { parseId } from "../../../utils/ids.js";
import { createLead } from "./opportunityService.js";
import { assertAssignable, assignSalesperson } from "./leadWorkflowService.js";

const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

const pick = (...values) => values.find((v) => v !== undefined && v !== null && String(v).trim() !== "");

/**
 * Body: the usual lead fields plus, under either name,
 *   firstName | customerFirstName, lastName | customerLastName,
 *   phone | customerPhone, email | customerEmail,
 *   address (a string, or { line1, suburb, state, postcode }) | siteLine1 (+ siteSuburb, siteState, sitePostcode),
 *   salespersonId (required unless unassignedReason is given), businessUnitId
 * Every missing mandatory field is reported at once (errors: [{ field, message }]).
 */
export const intakeLead = async (payload = {}, actor, ctx = null) => {
    const firstName = oneLine(pick(payload.firstName, payload.customerFirstName), 100);
    const lastName = oneLine(pick(payload.lastName, payload.customerLastName), 100);
    const phone = oneLine(pick(payload.phone, payload.customerPhone), 30);
    const email = oneLine(pick(payload.email, payload.customerEmail), 254).toLowerCase();
    const address = typeof payload.address === "object" && payload.address !== null ? payload.address : { line1: payload.address };
    const siteLine1 = oneLine(pick(address.line1, payload.siteLine1), 255);
    const siteSuburb = oneLine(pick(address.suburb, payload.siteSuburb), 255) || undefined;
    const siteState = oneLine(pick(address.state, payload.siteState), 10) || undefined;
    const sitePostcode = oneLine(pick(address.postcode, payload.sitePostcode), 10) || undefined;

    const errors = [];
    if (!firstName) errors.push({ field: "firstName", message: "First name is required" });
    if (!lastName) errors.push({ field: "lastName", message: "Last name is required" });
    if (!siteLine1) errors.push({ field: "address", message: "Address is required" });
    if (!phone) errors.push({ field: "phone", message: "Phone number is required" });
    else if ((phone.match(/\d/g) || []).length < 8) errors.push({ field: "phone", message: "Enter a valid phone number" });
    if (!email) errors.push({ field: "email", message: "Email address is required" });
    else if (!EMAIL_RE.test(email)) errors.push({ field: "email", message: "Enter a valid email address" });
    const salespersonId = pick(payload.salespersonId);
    const unassignedReason = oneLine(payload.unassignedReason, 2000);
    if (!salespersonId && !unassignedReason)
        errors.push({ field: "salespersonId", message: "Assign the lead to a sales representative (or give the reason it is unassigned)" });
    if (errors.length) throw httpError(400, errors.map((e) => e.message).join("; "), { errors });

    // The representative is checked before anything is created — active and in
    // the unit — so a bad id never leaves an unassigned lead behind.
    if (salespersonId) await assertAssignable(salespersonId, { businessUnitId: parseId(payload.businessUnitId, "businessUnitId") }, "salesperson");

    const { firstName: _f, lastName: _l, phone: _p, email: _e, address: _a, salespersonId: _s, unassignedReason: _u, ...rest } = payload;
    const created = await createLead(
        {
            ...rest,
            customerFirstName: firstName,
            customerLastName: lastName,
            customerLegalName: oneLine(pick(payload.customerLegalName), 255) || `${firstName} ${lastName}`,
            customerPhone: phone,
            customerEmail: email,
            siteLine1,
            ...(siteSuburb ? { siteSuburb } : {}),
            ...(siteState ? { siteState } : {}),
            ...(sitePostcode ? { sitePostcode } : {}),
            leadSource: payload.leadSource ?? "internal",
        },
        actor,
        { ctx }
    );
    await assignSalesperson(created.id, salespersonId ? { salespersonId } : { salespersonId: null, reason: unassignedReason }, actor, ctx);
    return created.id;
};
