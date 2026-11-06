// The webhook deliveries themselves — what Meta and Google send, checked and
// handed to inboundLeadService.ingestLead under the right connection.
//
// Meta subscribes one URL per app to the page object's "leadgen" field. Each
// delivery is signed with the app secret (X-Hub-Signature-256 over the raw
// body) and names the page and the lead id; the answers are fetched from the
// Graph API with the connection's Page token. Meta retries a delivery it did
// not get a 2xx for, so anything that is this server's problem (no token,
// the fetch failed) is still answered 200 — the lead is filed as a stub to
// refresh — and only a bad signature is refused.
//
// Google Ads posts the whole lead to the URL on the form asset, with the key
// typed there as google_key. The key finds the connection; a key nobody has
// is refused with 403, which Google shows on the asset so a typo is noticed.
import crypto from "node:crypto";
import db from "../../../models/index.js";
import logger from "../../../utils/logger.js";
import { open as openSecret } from "../../../utils/secretBox.js";
import { fetchLead, verifySignature } from "./metaGraph.js";
import { googleLeadInput, metaFormName, metaLeadInput, metaStubInput } from "./platformLeads.js";
import { ingestLead } from "./inboundLeadService.js";

const { IntegrationConnection } = db;

const httpError = (status, message) => Object.assign(new Error(message), { status });

const safeEqual = (a, b) => {
    const left = Buffer.from(String(a ?? ""), "utf8");
    const right = Buffer.from(String(b ?? ""), "utf8");
    return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
};

// ---- Meta -------------------------------------------------------------------

/** The subscription handshake: GET ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=… → the challenge, as text. */
export const metaVerification = (query = {}) => {
    const expected = String(process.env.META_WEBHOOK_VERIFY_TOKEN ?? "").trim();
    if (!expected) throw httpError(503, "META_WEBHOOK_VERIFY_TOKEN is not set on the server");
    if (query["hub.mode"] !== "subscribe" || !safeEqual(query["hub.verify_token"], expected))
        throw httpError(403, "Verification token does not match");
    return String(query["hub.challenge"] ?? "");
};

const fileMetaLead = async (connection, change, summary) => {
    let token = null;
    try {
        token = openSecret(connection.credentials?.pageAccessToken) || null;
    } catch (err) {
        logger.warn(`Meta webhook: connection ${connection.id} token cannot be read — ${err.message}`);
    }

    let input;
    if (!token) {
        input = metaStubInput(change, { fetchError: "The connection has no Page access token" });
    } else {
        try {
            const lead = await fetchLead(change.leadgen_id, token);
            const formName = await metaFormName(lead.form_id ?? change.form_id, token);
            input = metaLeadInput(lead, { formName, webhook: change });
            if (connection.lastError) await connection.update({ lastError: null, lastErrorAt: null });
        } catch (err) {
            logger.warn(`Meta webhook: lead ${change.leadgen_id} on connection ${connection.id} could not be fetched — ${err.message}`);
            await connection.update({ lastError: err.message, lastErrorAt: new Date() });
            input = metaStubInput(change, { fetchError: err.message });
        }
    }

    const result = await ingestLead(connection, input);
    if (result.created) summary.filed += 1;
    else summary.repeated += 1;
    if (input.fetchError && result.created) summary.stubs += 1;
};

/**
 * One POST from Meta: { object: "page", entry: [{ id, changes: [{ field: "leadgen", value: { leadgen_id, page_id, form_id, … } }] }] }
 * → { received, filed, repeated, stubs, unknownPages }. Throws 401 on a bad
 * signature and 503 when the server has no app secret to check it with.
 */
export const metaDelivery = async ({ rawBody, signature, body }) => {
    const appSecret = String(process.env.META_APP_SECRET ?? "").trim();
    if (!appSecret) throw httpError(503, "META_APP_SECRET is not set on the server — deliveries cannot be verified");
    if (!verifySignature(rawBody, signature, appSecret)) throw httpError(401, "Invalid signature");

    const summary = { received: 0, filed: 0, repeated: 0, stubs: 0, unknownPages: [] };
    if (body?.object !== "page") return summary;

    for (const entry of Array.isArray(body.entry) ? body.entry : []) {
        for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
            const value = change?.value;
            if (change?.field !== "leadgen" || !value?.leadgen_id) continue;
            summary.received += 1;
            const pageId = String(value.page_id ?? entry.id ?? "");
            const connection = await IntegrationConnection.findOne({ where: { platform: "meta_ads", externalAccountId: pageId, isActive: true } });
            if (!connection) {
                if (!summary.unknownPages.includes(pageId)) summary.unknownPages.push(pageId);
                logger.warn(`Meta webhook: no active connection for page ${pageId || "(unknown)"} — lead ${value.leadgen_id} not filed`);
                continue;
            }
            await fileMetaLead(connection, value, summary);
        }
    }
    return summary;
};

// ---- Google Ads -------------------------------------------------------------

/**
 * One POST from a Google Ads lead form: { lead_id, google_key, user_column_data: […], campaign_id, …, is_test }
 * → { leadId, created, converted, isTest }. Throws 403 for a key no active connection holds.
 */
export const googleDelivery = async (body) => {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw httpError(400, "Send a JSON object");
    const key = typeof body.google_key === "string" ? body.google_key.trim() : "";
    if (key.length < 16) throw httpError(403, "google_key is missing");
    const connection = await IntegrationConnection.findOne({ where: { platform: "google_ads", webhookSecret: key } });
    if (!connection || !safeEqual(connection.webhookSecret, key)) throw httpError(403, "google_key does not match any connection");
    if (!connection.isActive) throw httpError(403, "This connection is switched off");
    if (!body.lead_id) throw httpError(400, "lead_id is required");

    const result = await ingestLead(connection, googleLeadInput(body));
    return { leadId: result.lead.id, created: result.created, converted: result.converted, isTest: body.is_test === true };
};
