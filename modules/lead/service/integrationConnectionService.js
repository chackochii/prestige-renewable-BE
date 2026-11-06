// Lead connections: the ad accounts a business unit takes leads from, managed
// on Administration → Lead connections. One row per account; the webhook
// layer (webhookService) finds the row for each delivery and files the lead
// under its unit.
//
//   Meta Ads   — externalAccountId is the Facebook Page id, credentials hold a
//                Page access token (sealed at rest, utils/secretBox). The
//                webhook is app-wide (META_APP_SECRET, META_WEBHOOK_VERIFY_TOKEN);
//                the page id in each delivery picks the connection.
//   Google Ads — webhookSecret is the key typed into the lead form asset; the
//                key in each delivery picks the connection. Nothing to fetch.
//
// Tokens are never returned: the API shows "••••1234" so an admin can tell
// which token is in place. The Google key is returned — the admin has to
// paste it into Google Ads.
import crypto from "node:crypto";
import db from "../../../models/index.js";
import { parseId } from "../../../utils/ids.js";
import { oneLine } from "../../../utils/text.js";
import { canAccessUnit } from "../../../utils/unitScope.js";
import { isSealingEnabled, mask, open as openSecret, seal } from "../../../utils/secretBox.js";
import logger from "../../../utils/logger.js";
import { PLATFORM_LABELS, SUPPORTED_PLATFORMS } from "../model/integrationConnection.js";
import { MAPPABLE_COLUMNS } from "./leadNormalizer.js";
import { fetchPage, listForms, listFormLeads, subscribePage } from "./metaGraph.js";
import { metaLeadInput, rememberMetaForms } from "./platformLeads.js";
import { ingestLead } from "./inboundLeadService.js";

const { IntegrationConnection, BusinessUnit, InboundLead, sequelize } = db;

const httpError = (status, message, errors = null) => Object.assign(new Error(message), { status, ...(errors ? { errors } : {}) });

const backendUrl = () => String(process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 8000}`).replace(/\/+$/, "");

/** Where each platform must send its deliveries. */
export const webhookUrlFor = (platform) => `${backendUrl()}/api/webhooks/${platform === "google_ads" ? "google-ads" : "meta"}`;

/** What the server has been given for the app-wide Meta webhook — shown on the screen as setup status. */
export const metaSetup = () => ({
    appSecretSet: Boolean(String(process.env.META_APP_SECRET ?? "").trim()),
    verifyToken: String(process.env.META_WEBHOOK_VERIFY_TOKEN ?? "").trim() || null,
    tokensSealed: isSealingEnabled(),
});

export const newSecret = () => crypto.randomBytes(24).toString("hex"); // 48 characters

// ---- Presenting -------------------------------------------------------------

export const presentConnection = (row, { leadCount = null } = {}) => {
    const plain = typeof row.get === "function" ? row.get({ plain: true }) : { ...row };
    return {
        id: plain.id,
        businessUnitId: plain.businessUnitId,
        platform: plain.platform,
        platformLabel: PLATFORM_LABELS[plain.platform] ?? plain.platform,
        name: plain.name,
        externalAccountId: plain.externalAccountId ?? null,
        // The Google key is what the admin pastes into the form asset; Meta has no per-connection secret to show.
        webhookSecret: plain.platform === "google_ads" ? plain.webhookSecret ?? null : null,
        webhookUrl: webhookUrlFor(plain.platform),
        credentials: { pageAccessToken: mask(plain.credentials?.pageAccessToken) },
        config: { fieldMap: plain.config?.fieldMap ?? {} },
        autoConvert: Boolean(plain.autoConvert),
        isActive: Boolean(plain.isActive),
        lastEventAt: plain.lastEventAt ?? null,
        lastSyncAt: plain.lastSyncAt ?? null,
        lastError: plain.lastError ?? null,
        lastErrorAt: plain.lastErrorAt ?? null,
        leadCount,
        createdAt: plain.createdAt,
        updatedAt: plain.updatedAt,
    };
};

const loadConnection = async (id, actor) => {
    const connection = await IntegrationConnection.findByPk(parseId(id, "connection id"));
    if (!connection || (actor && !canAccessUnit(actor, connection.businessUnitId))) throw httpError(404, "Connection not found");
    return connection;
};

// ---- Validation -------------------------------------------------------------

const cleanFieldMap = (value) => {
    if (value === undefined) return undefined;
    if (value === null) return {};
    if (typeof value !== "object" || Array.isArray(value)) throw httpError(400, "config.fieldMap must be an object of { formField: column }");
    const out = {};
    for (const [key, column] of Object.entries(value)) {
        const field = oneLine(key, 120);
        if (!field) continue;
        if (!MAPPABLE_COLUMNS.includes(column)) throw httpError(400, `fieldMap: "${field}" maps to unknown column "${column}" (one of ${MAPPABLE_COLUMNS.join(", ")})`);
        out[field] = column;
    }
    return out;
};

const cleanInput = (body = {}, { platform, existing = null }) => {
    const fields = {};
    if (body.name !== undefined || !existing) {
        const name = oneLine(body.name, 100);
        if (!name) throw httpError(400, "name is required", [{ field: "name", message: "Give the connection a name." }]);
        fields.name = name;
    }
    if (body.externalAccountId !== undefined || !existing) {
        const accountId = oneLine(body.externalAccountId, 100);
        if (platform === "meta_ads") {
            if (!/^\d{5,30}$/.test(accountId))
                throw httpError(400, "A Meta connection needs the Facebook Page id (digits only)", [{ field: "externalAccountId", message: "Enter the Facebook Page id — digits only." }]);
        }
        fields.externalAccountId = accountId || null;
    }
    if (body.credentials !== undefined) {
        if (typeof body.credentials !== "object" || body.credentials === null || Array.isArray(body.credentials))
            throw httpError(400, "credentials must be an object");
        const token = typeof body.credentials.pageAccessToken === "string" ? body.credentials.pageAccessToken.trim() : "";
        // Blank keeps the token already stored; only a value replaces it.
        if (token) fields.credentials = { ...(existing?.credentials ?? {}), pageAccessToken: seal(token) };
        else if (body.credentials.pageAccessToken === null) fields.credentials = { ...(existing?.credentials ?? {}), pageAccessToken: null };
    }
    if (body.config !== undefined) {
        if (typeof body.config !== "object" || body.config === null || Array.isArray(body.config)) throw httpError(400, "config must be an object");
        const fieldMap = cleanFieldMap(body.config.fieldMap);
        fields.config = { ...(existing?.config ?? {}), ...(fieldMap !== undefined ? { fieldMap } : {}) };
    }
    if (body.autoConvert !== undefined) fields.autoConvert = body.autoConvert === true || body.autoConvert === "true";
    if (body.isActive !== undefined) fields.isActive = body.isActive === true || body.isActive === "true";
    return fields;
};

// ---- CRUD -------------------------------------------------------------------

/** ?businessUnitId= → the unit's connections with how many leads each has filed. */
export const listConnections = async (query = {}) => {
    const businessUnitId = parseId(query.businessUnitId, "business unit id");
    const rows = await IntegrationConnection.findAll({ where: { businessUnitId }, order: [["createdAt", "ASC"], ["id", "ASC"]] });
    const counts = rows.length
        ? await InboundLead.findAll({
              where: { connectionId: rows.map((row) => row.id) },
              attributes: ["connectionId", [sequelize.fn("COUNT", sequelize.col("id")), "count"]],
              group: ["connectionId"],
              raw: true,
          })
        : [];
    const countOf = new Map(counts.map((row) => [Number(row.connectionId), Number(row.count)]));
    return rows.map((row) => presentConnection(row, { leadCount: countOf.get(row.id) ?? 0 }));
};

export const getConnection = async (id, actor) => presentConnection(await loadConnection(id, actor));

/**
 * { businessUnitId, platform, name, externalAccountId?, credentials?: { pageAccessToken }, config?: { fieldMap }, autoConvert?, isActive? }
 * → the connection. A Google connection gets its key here; the admin pastes it into the form asset.
 */
export const createConnection = async (body = {}, actor) => {
    const businessUnitId = parseId(body.businessUnitId, "business unit id");
    if (!(await BusinessUnit.findByPk(businessUnitId, { attributes: ["id"] }))) throw httpError(404, "Business unit not found");
    const platform = String(body.platform ?? "");
    if (!SUPPORTED_PLATFORMS.includes(platform))
        throw httpError(400, `platform must be one of: ${SUPPORTED_PLATFORMS.join(", ")}`, [{ field: "platform", message: "Choose Meta Ads or Google Ads." }]);
    const fields = cleanInput(body, { platform });
    if (platform === "meta_ads" && !fields.credentials?.pageAccessToken)
        throw httpError(400, "A Meta connection needs a Page access token", [{ field: "pageAccessToken", message: "Paste the Page access token." }]);
    const row = await IntegrationConnection.create({
        businessUnitId,
        platform,
        ...fields,
        credentials: fields.credentials ?? {},
        config: fields.config ?? {},
        webhookSecret: platform === "google_ads" ? newSecret() : null,
    });
    logger.info(`Lead connection ${row.id} (${platform}) created for unit ${businessUnitId}${actor ? ` by ${actor.name}` : ""}`);
    return presentConnection(row, { leadCount: 0 });
};

/** Any of name, externalAccountId, credentials, config, autoConvert, isActive. The platform never changes. */
export const updateConnection = async (id, body = {}, actor) => {
    const connection = await loadConnection(id, actor);
    const fields = cleanInput(body, { platform: connection.platform, existing: connection });
    await connection.update(fields);
    return presentConnection(connection);
};

/** The leads filed through it stay (connection_id → null). */
export const deleteConnection = async (id, actor) => {
    const connection = await loadConnection(id, actor);
    await connection.destroy();
    logger.info(`Lead connection ${connection.id} (${connection.platform}) deleted${actor ? ` by ${actor.name}` : ""}`);
};

/** A new Google key; the old one stops working the moment this returns. */
export const rotateSecret = async (id, actor) => {
    const connection = await loadConnection(id, actor);
    if (connection.platform !== "google_ads") throw httpError(400, "Only a Google Ads connection has a key to rotate");
    await connection.update({ webhookSecret: newSecret() });
    return presentConnection(connection);
};

// ---- Talking to the platform ------------------------------------------------

const pageToken = (connection) => {
    const token = openSecret(connection.credentials?.pageAccessToken);
    if (!token) throw httpError(409, "This connection has no Page access token");
    return token;
};

const recordFailure = async (connection, err) => {
    await connection.update({ lastError: err.message, lastErrorAt: new Date() });
};

/**
 * Meta: reads the page and its lead forms with the stored token, and
 * subscribes the app to the page's leadgen events (the per-page step the
 * webhook needs) → { ok, page, forms, subscription: { subscribed, error? } }.
 * Google: nothing to call; → { ok, hint } with where to send test data.
 */
export const testConnection = async (id, actor) => {
    const connection = await loadConnection(id, actor);
    if (connection.platform === "google_ads")
        return {
            ok: true,
            webhookUrl: webhookUrlFor("google_ads"),
            hint: "Put the webhook URL and key on the lead form asset in Google Ads and use its “Send test data” button — the test lead appears in the inbox marked as a test.",
        };
    const token = pageToken(connection);
    try {
        const page = await fetchPage(connection.externalAccountId, token);
        const forms = await listForms(connection.externalAccountId, token);
        rememberMetaForms(forms);
        // Reading works; subscribing can still fail (a token without
        // pages_manage_metadata), which is reported rather than failing the test.
        let subscription;
        try {
            const result = await subscribePage(connection.externalAccountId, token);
            subscription = { subscribed: result?.success === true };
        } catch (err) {
            subscription = { subscribed: false, error: err.message };
        }
        await connection.update({ lastError: null, lastErrorAt: null });
        return {
            ok: true,
            page: { id: page.id, name: page.name },
            forms: forms.map((form) => ({ id: form.id, name: form.name, status: form.status })),
            subscription,
        };
    } catch (err) {
        await recordFailure(connection, err);
        throw httpError(err.status === 401 ? 409 : 502, err.message);
    }
};

// Poll window on the first run, and the overlap kept on later runs so a lead
// created while the previous poll ran is not skipped.
const FIRST_SYNC_DAYS = 30;
const OVERLAP_MS = 60 * 60 * 1000;

/**
 * Meta: pulls every lead form's leads since the last poll through ingestLead
 * → { forms, fetched, created, converted }. Webhooks deliver in real time; this
 * is the safety net (and the way to import leads that arrived before the
 * connection existed).
 */
export const syncConnection = async (connectionOrId, actor = null) => {
    const connection = typeof connectionOrId === "object" ? connectionOrId : await loadConnection(connectionOrId, actor);
    if (connection.platform !== "meta_ads") throw httpError(400, "Only a Meta Ads connection can be synced; Google Ads only pushes");
    const token = pageToken(connection);
    const since = connection.lastSyncAt ? new Date(new Date(connection.lastSyncAt).getTime() - OVERLAP_MS) : new Date(Date.now() - FIRST_SYNC_DAYS * 86400000);
    const startedAt = new Date();
    const summary = { forms: 0, fetched: 0, created: 0, converted: 0 };
    try {
        const forms = await listForms(connection.externalAccountId, token);
        rememberMetaForms(forms);
        summary.forms = forms.length;
        for (const form of forms) {
            const leads = await listFormLeads(form.id, token, { since });
            for (const lead of leads) {
                summary.fetched += 1;
                const result = await ingestLead(connection, metaLeadInput(lead, { formName: form.name ?? null }));
                if (result.created) summary.created += 1;
                if (result.converted) summary.converted += 1;
            }
        }
        await connection.update({ lastSyncAt: startedAt, lastError: null, lastErrorAt: null });
    } catch (err) {
        await recordFailure(connection, err);
        throw httpError(err.status === 401 ? 409 : err.status ?? 502, err.message);
    }
    logger.info(`Lead connection ${connection.id}: sync fetched ${summary.fetched}, filed ${summary.created} new lead(s)`);
    return summary;
};

/** Every active Meta connection with a token, for the scheduled poll. */
export const pollableConnections = () =>
    IntegrationConnection.findAll({ where: { platform: "meta_ads", isActive: true }, order: [["id", "ASC"]] });
