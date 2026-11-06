// Meta Graph API — the calls lead capture needs, and nothing else. A Page
// access token (a System User token with leads_retrieval, pages_show_list and
// pages_manage_metadata) reads a page's lead forms and the leads on them.
//
// A webhook only says "lead 123 arrived on page 456"; fetchLead() gets the
// answers. The same lead object comes back from a form's /leads listing,
// which the poll (integrationConnectionService.syncConnection) reads.
import crypto from "node:crypto";

const graphVersion = () => String(process.env.META_GRAPH_VERSION || "v26.0").trim();
const graphUrl = () => `https://graph.facebook.com/${graphVersion()}`;
const TIMEOUT_MS = 15000;

/** Fields of a lead object worth keeping. The ad/adset/campaign ones need ads permissions on the token (ads_management / ads_read). */
export const LEAD_FIELDS = "id,created_time,field_data,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,is_organic,platform";
/** What a token with only the page permissions can read: the answers, without attribution. */
export const BASE_LEAD_FIELDS = "id,created_time,field_data,form_id,is_organic,platform";

export class MetaGraphError extends Error {
    constructor(message, { status = 502, code = null, subcode = null, type = null } = {}) {
        super(message);
        this.name = "MetaGraphError";
        this.status = status;
        this.code = code;
        this.subcode = subcode;
        this.type = type;
    }
}

const readJson = async (response) => {
    let body;
    try {
        body = await response.json();
    } catch {
        throw new MetaGraphError(`Meta answered ${response.status} without JSON`);
    }
    if (!response.ok || body?.error) {
        const error = body?.error ?? {};
        // 190 = invalid/expired token, 10 and 200 = a permission the token lacks.
        const denied = [190, 10, 200].includes(Number(error.code));
        throw new MetaGraphError(error.message ? `Meta: ${error.message}` : `Meta answered ${response.status}`, {
            status: denied ? 401 : 502,
            code: error.code ?? null,
            subcode: error.error_subcode ?? null,
            type: error.type ?? null,
        });
    }
    return body;
};

const get = async (url) => {
    let response;
    try {
        response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
        throw new MetaGraphError(`Meta did not answer: ${err.name === "TimeoutError" ? "timed out" : err.message}`);
    }
    return readJson(response);
};

const call = (path, { token, params = {} } = {}) => {
    const url = new URL(`${graphUrl()}/${String(path).replace(/^\//, "")}`);
    for (const [key, value] of Object.entries(params))
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    if (token) url.searchParams.set("access_token", token);
    return get(url);
};

const post = async (path, { token, params = {} } = {}) => {
    const url = new URL(`${graphUrl()}/${String(path).replace(/^\//, "")}`);
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params))
        if (value !== undefined && value !== null) body.set(key, String(value));
    if (token) body.set("access_token", token);
    let response;
    try {
        response = await fetch(url, { method: "POST", body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
        throw new MetaGraphError(`Meta did not answer: ${err.name === "TimeoutError" ? "timed out" : err.message}`);
    }
    return readJson(response);
};

/** Follows paging.next until there is none, `max` rows or the pages run out. */
const collect = async (first, max) => {
    const rows = [];
    let body = first;
    for (;;) {
        rows.push(...(body.data ?? []));
        const next = body.paging?.next;
        if (!next || rows.length >= max) break;
        body = await get(next);
    }
    return rows;
};

// A token without the ads permissions is refused the ad-level fields; the
// answers still matter more than the attribution, so ask again for just those.
const withoutAdFields = async (attempt) => {
    try {
        return await attempt(LEAD_FIELDS);
    } catch (err) {
        if (err instanceof MetaGraphError && err.code !== 190) return attempt(BASE_LEAD_FIELDS);
        throw err;
    }
};

/** The lead's answers and attribution: { id, created_time, field_data: [{ name, values }], ad_id, …, form_id }. */
export const fetchLead = (leadgenId, token) => withoutAdFields((fields) => call(leadgenId, { token, params: { fields } }));

/** { id, name } — proves the token reaches the page. */
export const fetchPage = (pageId, token) => call(pageId, { token, params: { fields: "id,name" } });

/** { id, name, status } of a lead form; used to label leads. */
export const fetchForm = (formId, token) => call(formId, { token, params: { fields: "id,name,status" } });

/**
 * Subscribes the app the token belongs to, to the page's leadgen events —
 * the step Meta's webhook needs besides the app-level subscription. Safe to
 * repeat. Needs pages_manage_metadata on the token.
 */
export const subscribePage = (pageId, token) => post(`${pageId}/subscribed_apps`, { token, params: { subscribed_fields: "leadgen" } });

/** Every lead form on the page: [{ id, name, status }]. */
export const listForms = async (pageId, token) =>
    collect(await call(`${pageId}/leadgen_forms`, { token, params: { fields: "id,name,status", limit: 100 } }), 500);

/**
 * Leads on a form created after `since` (a Date), up to `max`. Each is the
 * same object fetchLead() returns.
 */
export const listFormLeads = async (formId, token, { since = null, max = 1000 } = {}) => {
    const params = { limit: 100 };
    if (since) {
        const value = Math.floor(new Date(since).getTime() / 1000);
        params.filtering = JSON.stringify([{ field: "time_created", operator: "GREATER_THAN", value }]);
    }
    return withoutAdFields(async (fields) => collect(await call(`${formId}/leads`, { token, params: { ...params, fields } }), max));
};

/**
 * Checks X-Hub-Signature-256 on a webhook delivery: sha256 HMAC of the raw
 * body with the app secret. Constant-time compare; a missing or malformed
 * header is simply "no".
 */
export const verifySignature = (rawBody, header, appSecret) => {
    if (!rawBody || !header || !appSecret) return false;
    const [scheme, given] = String(header).split("=");
    if (scheme !== "sha256" || !given) return false;
    const expected = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
    const a = Buffer.from(given, "utf8");
    const b = Buffer.from(expected, "utf8");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
};
