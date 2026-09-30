// The pre-site inspection form (CL-04), as the site crew member fills it in
// through the site-visit link (EST-06). Every site-visit form carries it in
// full: the items the requester or coordinator marked become required, the
// rest are optional — a half-filled report beats a blank one.
//
// Job details (customer, address, job and quote number, the crew member) come
// from the job record and are not entered. The inspection date is entered
// (defaulting to today); the submission date is recorded by the server when
// the form is sent. The signature is always required — it is the sign-off.
//
// Keys match prestige-fe/src/constants/inspectionReport.js, so a requester's
// ticked checklist items and the form's answers line up.

export const SITE_PHOTOS_KEY = "site_photos";

export const INSPECTION_FORM = [
    // Job details
    { key: "inspectionDate", label: "Inspection date", kind: "date", section: "Job Details", required: true },

    // Site inspection
    { key: "siteAccessConfirmed", label: "Site address and property access confirmed", kind: "checkbox", section: "Site Inspection" },
    { key: "roofCondition", label: "Roof condition and roof type", kind: "text", section: "Site Inspection" },
    { key: "roofDimensions", label: "Roof dimensions and available installation area", kind: "text", section: "Site Inspection" },
    { key: "roofPitch", label: "Roof pitch and orientation", kind: "text", section: "Site Inspection" },
    { key: "shading", label: "Shading or obstructions identified", kind: "textarea", section: "Site Inspection" },
    { key: "switchboard", label: "Switchboard location and condition", kind: "textarea", section: "Site Inspection" },
    { key: "meter", label: "Meter location and meter type", kind: "text", section: "Site Inspection" },
    { key: "inverterLocation", label: "Proposed inverter location", kind: "text", section: "Site Inspection" },
    { key: "batteryLocation", label: "Proposed battery location", kind: "text", section: "Site Inspection" },
    { key: "cablePathway", label: "Cable pathway and approximate cable length", kind: "text", section: "Site Inspection" },
    { key: "accessDifficulties", label: "Access or installation difficulties identified", kind: "textarea", section: "Site Inspection" },
    { key: "scaffoldRequired", label: "Scaffolding or EWP (elevated work platform) required", kind: "checkbox", section: "Site Inspection" },
    { key: "additionalWork", label: "Additional electrical or building work noted", kind: "textarea", section: "Site Inspection" },
    { key: "unconfirmed", label: "Anything that cannot be confirmed from photos or mapping", kind: "textarea", section: "Site Inspection" },

    // Photos & notes (the photos themselves upload to the SITE_PHOTOS_KEY slot)
    { key: "measurements", label: "Measurements and site observations", kind: "textarea", section: "Photos & Notes" },
    { key: "risks", label: "Risks or special requirements", kind: "textarea", section: "Photos & Notes" },
    { key: "estimationComments", label: "Comments for the Estimation team", kind: "textarea", section: "Photos & Notes" },

    // Final check
    { key: "findingsRecorded", label: "All site findings recorded", kind: "checkbox", section: "Final Check" },
    { key: "photosUploaded", label: "Photos uploaded", kind: "checkbox", section: "Final Check" },
    { key: "measurementsRecorded", label: "Measurements recorded", kind: "checkbox", section: "Final Check" },
    { key: "estimationNotified", label: "Estimation team notified of any special requirements", kind: "checkbox", section: "Final Check" },

    // Sign-off
    { key: "signature", label: "Site crew member signature", kind: "signature", section: "Sign-off", required: true },
];

/**
 * Checklist keys the form fills in by itself, so a request that ticked them
 * never makes the crew member enter them: the submission date is the day it
 * is sent, and "signed by" is the name they give.
 */
export const AUTO_KEYS = ["submittedOn", "signedBy"];

const FORM_KEYS = new Set(INSPECTION_FORM.map((field) => field.key));

/**
 * The fields a submission is checked against: the whole form, with the items
 * the request asked for made required, plus any extra question the
 * coordinator added that is not on the form.
 */
export const fieldsToCheck = (requestedFields = []) => {
    const asked = new Set(requestedFields.map((field) => field.key));
    const form = INSPECTION_FORM.map((field) => ({ ...field, required: Boolean(field.required) || asked.has(field.key) }));
    const extra = requestedFields
        .filter((field) => !FORM_KEYS.has(field.key) && !AUTO_KEYS.includes(field.key))
        .map((field) => ({ ...field, required: true, section: "Also asked by the coordinator" }));
    return [...form, ...extra];
};
