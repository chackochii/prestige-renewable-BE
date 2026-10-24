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
// Keys, labels and order match prestige-fe/src/constants/inspectionReport.js,
// so a requester's ticked checklist items and the form's answers line up.
// "Estimation team notified" left the final check in UAT (Oct 2026): sending
// the form notifies them anyway.

export const SITE_PHOTOS_KEY = "site_photos";

export const INSPECTION_FORM = [
    // Job details
    { key: "inspectionDate", label: "Inspection date", kind: "date", section: "Job Details", required: true },

    // Site inspection — what the requester picks from on the request
    { key: "roofCondition", label: "Roof Condition and Roof Type", kind: "text", section: "Site Inspection" },
    { key: "roofDimensions", label: "Roof Dimensions and Available Installation Area", kind: "text", section: "Site Inspection" },
    { key: "roofPitch", label: "Roof Pitch and Orientation", kind: "text", section: "Site Inspection" },
    { key: "shading", label: "Shading or Obstructions", kind: "textarea", section: "Site Inspection" },
    { key: "switchboard", label: "Switchboard Location and Condition", kind: "textarea", section: "Site Inspection" },
    { key: "meter", label: "Meter Location and Meter Type", kind: "text", section: "Site Inspection" },
    { key: "inverterLocation", label: "Proposed Inverter Location", kind: "text", section: "Site Inspection" },
    { key: "batteryLocation", label: "Proposed Battery Location", kind: "text", section: "Site Inspection" },
    { key: "cablePathway", label: "Cable Pathway and Approximate Cable Length", kind: "text", section: "Site Inspection" },
    { key: "scaffoldRequired", label: "Scaffolding or Elevated Work Platform (EWP) Requirements", kind: "checkbox", section: "Site Inspection" },

    // Site access & observations — on every crew form; the requester does not pick these
    { key: "siteAccessConfirmed", label: "Site address and property access confirmed?", kind: "checkbox", section: "Site Access & Observations" },
    { key: "accessDifficulties", label: "Any access or installation difficulties identified?", kind: "textarea", section: "Site Access & Observations" },
    { key: "additionalWork", label: "Any additional electrical or building work identified?", kind: "textarea", section: "Site Access & Observations" },
    { key: "measurements", label: "Measurements and Other Site Observations", kind: "textarea", section: "Site Access & Observations" },
    { key: "risks", label: "Risks or Special Requirements", kind: "textarea", section: "Site Access & Observations" },
    { key: "unconfirmed", label: "Is there anything that cannot be confirmed from photos or mapping?", kind: "textarea", section: "Site Access & Observations" },
    { key: "estimationComments", label: "Additional Comments for the Estimation Team", kind: "textarea", section: "Site Access & Observations" },

    // Photos upload to the SITE_PHOTOS_KEY slot.

    // Final check
    { key: "findingsRecorded", label: "All site findings recorded", kind: "checkbox", section: "Final Check" },
    { key: "photosUploaded", label: "Photos uploaded", kind: "checkbox", section: "Final Check" },
    { key: "measurementsRecorded", label: "Measurements recorded", kind: "checkbox", section: "Final Check" },

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
