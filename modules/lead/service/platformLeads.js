// What each platform's lead object looks like, translated into the one shape
// inboundLeadService.ingestLead takes:
//
//   { externalLeadId, fields: [{ key, label, value }], attribution: { campaignId, …, formName },
//     raw, receivedAt, isTest }
//
// Meta (Lead Ads) — a lead object from the Graph API (metaGraph.fetchLead or a
// form's /leads listing): answers in field_data [{ name, values }], ids and,
// with ads_read on the token, the campaign/adset/ad names.
//
// Google Ads (lead form assets) — the webhook body itself: answers in
// user_column_data [{ column_id, column_name, string_value }], ids only
// (campaign_id, adgroup_id, creative_id, form_id); the names are not sent.
import { fetchForm } from "./metaGraph.js";

const text = (value) => (value === undefined || value === null ? null : String(value));

// A Meta question key reads "what_is_your_roof_type?"; the reviewer sees "What is your roof type?".
const prettyLabel = (key) => {
    const words = String(key ?? "").replace(/_+/g, " ").trim();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Answer";
};

/** Meta lead object → ingest input. `formName` is looked up by the caller (metaFormName) when it can be. */
export const metaLeadInput = (lead, { formName = null, webhook = null } = {}) => ({
    externalLeadId: text(lead.id),
    fields: (Array.isArray(lead.field_data) ? lead.field_data : []).map((field) => ({
        key: field.name,
        label: prettyLabel(field.name),
        value: field.values,
    })),
    attribution: {
        campaignId: text(lead.campaign_id),
        campaignName: text(lead.campaign_name),
        adGroupId: text(lead.adset_id),
        adGroupName: text(lead.adset_name),
        adId: text(lead.ad_id),
        adName: text(lead.ad_name),
        formId: text(lead.form_id ?? webhook?.form_id),
        formName: text(formName),
    },
    raw: webhook ? { lead, webhook } : { lead },
    receivedAt: lead.created_time ? new Date(lead.created_time) : null,
    isTest: false,
});

/** A Meta webhook change whose lead could not be fetched: a stub, to be refreshed. */
export const metaStubInput = (change, { fetchError }) => ({
    externalLeadId: text(change.leadgen_id),
    fields: [],
    attribution: {
        campaignId: text(change.campaign_id),
        adGroupId: text(change.adgroup_id),
        adId: text(change.ad_id),
        formId: text(change.form_id),
    },
    raw: { webhook: change },
    receivedAt: change.created_time ? new Date(Number(change.created_time) * 1000) : null,
    isTest: false,
    fetchError,
});

/** Google Ads lead form webhook body → ingest input. The key is not kept with the lead. */
// eslint-disable-next-line no-unused-vars
export const googleLeadInput = ({ google_key, ...body }) => ({
    externalLeadId: text(body.lead_id),
    fields: (Array.isArray(body.user_column_data) ? body.user_column_data : []).map((column) => ({
        // Standard questions carry an id such as FULL_NAME; custom ones carry a
        // number, so their name is the only key the mapping can use.
        key: /^[A-Z_]+$/.test(String(column.column_id ?? "")) ? column.column_id : column.column_name,
        label: column.column_name ?? column.column_id,
        value: column.string_value ?? column.column_value?.string_value ?? null,
    })),
    attribution: {
        campaignId: text(body.campaign_id),
        adGroupId: text(body.adgroup_id),
        adId: text(body.creative_id),
        formId: text(body.form_id),
    },
    raw: body,
    receivedAt: body.lead_submit_time && !Number.isNaN(Date.parse(body.lead_submit_time)) ? new Date(body.lead_submit_time) : null,
    isTest: body.is_test === true,
});

// Form names, so the inbox can say "Solar quote form" rather than a 15-digit
// id. One lookup per form per hour per process.
const formNames = new Map();
const FORM_NAME_TTL_MS = 60 * 60 * 1000;

export const metaFormName = async (formId, token) => {
    if (!formId || !token) return null;
    const cached = formNames.get(String(formId));
    if (cached && cached.at > Date.now() - FORM_NAME_TTL_MS) return cached.name;
    try {
        const form = await fetchForm(formId, token);
        const name = form?.name ?? null;
        formNames.set(String(formId), { name, at: Date.now() });
        return name;
    } catch {
        return cached?.name ?? null; // the lead is still filed; only its label is missing
    }
};

/** Pre-fills the cache from a page's form list (one call for every form). */
export const rememberMetaForms = (forms = []) => {
    for (const form of forms) if (form?.id) formNames.set(String(form.id), { name: form.name ?? null, at: Date.now() });
};
