// The quote built at the estimation stage: one per opportunity, line items
// priced from the catalog (copied at add time) and additional costs. Totals
// and GST are derived by the client — nothing here stores a total.
//
// Its life: a `draft` while it is built (every edit is saved as it is made),
// then `generated` — frozen as the next version and locked, so what the
// customer is sent is exactly what the record holds. To change a generated
// quote the estimator starts a new one (startDraft): the lock comes off, the
// rows stay as the starting point, and generating again makes the next
// version. Generating a draft that is unchanged from the version it came
// from locks it back onto that version rather than making a duplicate.
import db from "../../../models/index.js";
import { parseId } from "../../../utils/ids.js";
import { unitDate } from "../../../utils/unitTime.js";
import { PROJECT_TYPES, TAX_TREATMENTS } from "../model/quote.js";
import { COST_CALC_TYPES } from "../model/quoteCost.js";
import { recordSystemEvent } from "./leadWorkflowService.js";

const { Opportunity, BusinessUnit, Quote, QuoteItem, QuoteCost, QuoteVersion, CatalogItem, User, sequelize } = db;

const httpError = (status, message) => Object.assign(new Error(message), { status });

const num = (value) => (value === null || value === undefined || value === "" ? null : Number(value));
const text = (value, max) => String(value ?? "").trim().slice(0, max);
const money = (value) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(Number(value) || 0);

const loadOpportunity = async (id) =>
    Opportunity.findByPk(parseId(id, "opportunity id"), {
        include: [{ model: User, as: "estimator", attributes: ["id", "name"] }],
    });

const VERSION_CREATOR = { model: User, as: "createdBy", attributes: ["id", "name"] };
const QUOTE_INCLUDE = [
    { model: QuoteItem, as: "items" },
    { model: QuoteCost, as: "additionalCosts" },
    { model: QuoteVersion, as: "generatedVersion", include: [VERSION_CREATOR] },
];
const QUOTE_ORDER = [
    [{ model: QuoteItem, as: "items" }, "sortOrder", "ASC"],
    [{ model: QuoteItem, as: "items" }, "id", "ASC"],
    [{ model: QuoteCost, as: "additionalCosts" }, "sortOrder", "ASC"],
    [{ model: QuoteCost, as: "additionalCosts" }, "id", "ASC"],
];

const findQuote = (opportunityId) => Quote.findOne({ where: { opportunityId }, include: QUOTE_INCLUDE, order: QUOTE_ORDER });

// ---- Presentation (DECIMAL columns arrive as strings) -----------------------

export const presentItem = (row) => ({
    id: row.id,
    itemKey: row.itemKey,
    itemName: row.itemName,
    brand: row.brand,
    unit: row.unit || "",
    quantity: Number(row.quantity) || 0,
    unitPrice: Number(row.unitPrice) || 0,
    discountPct: Number(row.discountPct) || 0,
});

export const presentCost = (row) => ({
    id: row.id,
    costType: row.costType,
    calcType: row.calcType,
    value: Number(row.value) || 0,
    description: row.description || "",
});

export const presentQuote = (quote, opportunity) => ({
    id: quote.id,
    opportunityId: quote.opportunityId,
    quoteNumber: quote.quoteNumber,
    customer: opportunity.customerLegalName || opportunity.customerTradingName || "",
    estimatorName: opportunity.estimator?.name ?? null,
    project: quote.project || "",
    projectType: quote.projectType,
    projectTypeOther: quote.projectTypeOther || "",
    quoteDate: quote.quoteDate || null,
    taxTreatment: quote.taxTreatment,
    gstRatePct: Number(quote.gstRatePct) || 0,
    items: (quote.items || []).map(presentItem),
    additionalCosts: (quote.additionalCosts || []).map(presentCost),
    // draft | generated — generated is locked to `generatedVersion`.
    status: quote.status || "draft",
    generatedAt: quote.generatedAt || null,
    generatedVersion: quote.generatedVersion ? presentVersion(quote.generatedVersion) : null,
    createdAt: quote.createdAt,
    updatedAt: quote.updatedAt,
});

const isGenerated = (quote) => quote.status === "generated";

/** Nothing on a generated quote changes — the version the customer gets is the record. */
const assertEditable = (quote) => {
    if (!isGenerated(quote)) return;
    const version = quote.generatedVersion?.version;
    throw httpError(
        409,
        `This quote has been generated${version ? ` as version ${version}` : ""} and can no longer be edited — create a new quote to make changes`
    );
};

// ---- Quote header -----------------------------------------------------------

/** The opportunity's quote, or null when none has been created yet. */
export const getQuote = async (id) => {
    const opportunity = await loadOpportunity(id);
    if (!opportunity) throw httpError(404, "Opportunity not found");
    const quote = await findQuote(opportunity.id);
    return quote ? presentQuote(quote, opportunity) : null;
};

const quoteNumberFor = (opportunity) => opportunity.number.replace(/^([A-Z0-9]+)-/, "$1-Q-");

/** Creates the quote (idempotent — an existing quote is returned as is). */
export const createQuote = async (id, actor) => {
    const opportunity = await loadOpportunity(id);
    if (!opportunity) throw httpError(404, "Opportunity not found");
    const existing = await findQuote(opportunity.id);
    if (existing) return presentQuote(existing, opportunity);
    // Dated the day it is where the unit works, not in UTC.
    const unit = await BusinessUnit.findByPk(opportunity.businessUnitId, { attributes: ["id", "timezone"] });
    await Quote.create({
        opportunityId: opportunity.id,
        quoteNumber: quoteNumberFor(opportunity),
        quoteDate: unitDate(unit),
        createdById: actor?.id ?? null,
    });
    return presentQuote(await findQuote(opportunity.id), opportunity);
};

const loadQuoteFor = async (id) => {
    const opportunity = await loadOpportunity(id);
    if (!opportunity) throw httpError(404, "Opportunity not found");
    const quote = await findQuote(opportunity.id);
    if (!quote) throw httpError(404, "No quote has been created for this opportunity yet");
    return { opportunity, quote };
};

/** { project?, projectType?, projectTypeOther?, quoteDate?, taxTreatment?, gstRatePct? } — a draft only. */
export const updateQuote = async (id, payload = {}) => {
    const { opportunity, quote } = await loadQuoteFor(id);
    assertEditable(quote);
    const update = {};
    if (payload.project !== undefined) update.project = text(payload.project, 255) || null;
    if (payload.projectType !== undefined) {
        if (!PROJECT_TYPES.includes(payload.projectType))
            throw httpError(400, `projectType must be one of: ${PROJECT_TYPES.join(", ")}`);
        update.projectType = payload.projectType;
        if (payload.projectType !== "Other") update.projectTypeOther = null;
    }
    if (payload.projectTypeOther !== undefined) update.projectTypeOther = text(payload.projectTypeOther, 255) || null;
    if (payload.quoteDate !== undefined) {
        if (payload.quoteDate === null || payload.quoteDate === "") update.quoteDate = null;
        else {
            const value = String(payload.quoteDate).slice(0, 10);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(new Date(value).getTime()))
                throw httpError(400, "quoteDate must be a date (yyyy-mm-dd)");
            update.quoteDate = value;
        }
    }
    if (payload.taxTreatment !== undefined) {
        if (!TAX_TREATMENTS.includes(payload.taxTreatment))
            throw httpError(400, `taxTreatment must be one of: ${TAX_TREATMENTS.join(", ")}`);
        update.taxTreatment = payload.taxTreatment;
    }
    if (payload.gstRatePct !== undefined) {
        const rate = num(payload.gstRatePct);
        if (rate === null || !Number.isFinite(rate) || rate < 0 || rate > 100)
            throw httpError(400, "gstRatePct must be between 0 and 100");
        update.gstRatePct = rate;
    }
    await quote.update(update);
    return presentQuote(await findQuote(opportunity.id), opportunity);
};

/** True when the opportunity's quote has at least one line item (the stage-2 advance gate). */
export const quoteHasItems = async (opportunityId) => {
    const quote = await Quote.findOne({ where: { opportunityId }, attributes: ["id"] });
    if (!quote) return false;
    return (await QuoteItem.count({ where: { quoteId: quote.id } })) > 0;
};

/**
 * True when the opportunity's quote is generated — locked to a version, with
 * no draft open on it (the other stage-2 gate: proposal sends that version).
 */
export const quoteIsGenerated = async (opportunityId) => {
    const quote = await Quote.findOne({ where: { opportunityId }, attributes: ["id", "status", "generatedVersionId"] });
    return Boolean(quote && isGenerated(quote) && quote.generatedVersionId);
};

// ---- Items ------------------------------------------------------------------

const itemFields = async (payload, { partial = false } = {}) => {
    const fields = {};
    const has = (key) => payload[key] !== undefined;

    if (has("itemKey") || !partial) {
        fields.itemKey = text(payload.itemKey, 100);
        if (!fields.itemKey) throw httpError(400, "itemKey is required");
    }
    if (has("itemName") || !partial) {
        fields.itemName = text(payload.itemName, 255);
        if (!fields.itemName && fields.itemKey) {
            const catalog = await CatalogItem.findOne({ where: { key: fields.itemKey } });
            fields.itemName = catalog?.name || "";
        }
        if (!fields.itemName) throw httpError(400, "itemName is required");
    }
    if (has("brand") || !partial) {
        fields.brand = text(payload.brand, 255);
        if (!fields.brand) throw httpError(400, "brand is required");
    }
    if (has("unit")) fields.unit = text(payload.unit, 30) || null;
    if (has("quantity") || !partial) {
        const quantity = num(payload.quantity);
        if (quantity === null || !Number.isFinite(quantity) || quantity <= 0)
            throw httpError(400, "quantity must be greater than zero");
        fields.quantity = quantity;
    }
    if (has("unitPrice") || !partial) {
        const price = num(payload.unitPrice) ?? 0;
        if (!Number.isFinite(price) || price < 0) throw httpError(400, "unitPrice cannot be negative");
        fields.unitPrice = price;
    }
    if (has("discountPct") || !partial) {
        const pct = num(payload.discountPct) ?? 0;
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw httpError(400, "discountPct must be between 0 and 100");
        fields.discountPct = pct;
    }
    return fields;
};

export const addItem = async (id, payload = {}) => {
    const { quote } = await loadQuoteFor(id);
    assertEditable(quote);
    const fields = await itemFields(payload);
    const row = await QuoteItem.create({ ...fields, quoteId: quote.id, sortOrder: (quote.items || []).length });
    return presentItem(row);
};

export const updateItem = async (id, itemId, payload = {}) => {
    const { quote } = await loadQuoteFor(id);
    assertEditable(quote);
    const row = await QuoteItem.findOne({ where: { id: parseId(itemId, "item id"), quoteId: quote.id } });
    if (!row) throw httpError(404, "Quote item not found");
    await row.update(await itemFields(payload, { partial: true }));
    return presentItem(row);
};

export const removeItem = async (id, itemId) => {
    const { quote } = await loadQuoteFor(id);
    assertEditable(quote);
    const row = await QuoteItem.findOne({ where: { id: parseId(itemId, "item id"), quoteId: quote.id } });
    if (!row) throw httpError(404, "Quote item not found");
    await row.destroy();
};

// ---- Additional costs -------------------------------------------------------

const costFields = (payload, current = null) => {
    const fields = {};
    const has = (key) => payload[key] !== undefined;
    const partial = Boolean(current);

    if (has("costType") || !partial) {
        fields.costType = text(payload.costType, 50);
        if (!fields.costType) throw httpError(400, "costType is required");
    }
    if (has("calcType") || !partial) {
        const calcType = payload.calcType ?? "fixed";
        if (!COST_CALC_TYPES.includes(calcType)) throw httpError(400, `calcType must be one of: ${COST_CALC_TYPES.join(", ")}`);
        fields.calcType = calcType;
    }
    if (has("value") || !partial) {
        const value = num(payload.value) ?? 0;
        if (!Number.isFinite(value) || value < 0) throw httpError(400, "value cannot be negative");
        fields.value = value;
    }
    if (has("description")) fields.description = text(payload.description, 500) || null;

    // The ceiling applies to the pair as it will be stored, so a partial
    // update that flips calcType to percentage while keeping a fixed value
    // above 100 is rejected just like sending both at once.
    const effectiveCalcType = fields.calcType ?? current?.calcType ?? "fixed";
    const effectiveValue = fields.value ?? Number(current?.value ?? 0);
    if (effectiveCalcType === "percentage" && effectiveValue > 100)
        throw httpError(400, "A percentage cost cannot exceed 100%");
    return fields;
};

export const addCost = async (id, payload = {}) => {
    const { quote } = await loadQuoteFor(id);
    assertEditable(quote);
    const fields = costFields(payload);
    const row = await QuoteCost.create({ ...fields, quoteId: quote.id, sortOrder: (quote.additionalCosts || []).length });
    return presentCost(row);
};

export const updateCost = async (id, costId, payload = {}) => {
    const { quote } = await loadQuoteFor(id);
    assertEditable(quote);
    const row = await QuoteCost.findOne({ where: { id: parseId(costId, "cost id"), quoteId: quote.id } });
    if (!row) throw httpError(404, "Quote cost not found");
    await row.update(costFields(payload, row));
    return presentCost(row);
};

export const removeCost = async (id, costId) => {
    const { quote } = await loadQuoteFor(id);
    assertEditable(quote);
    const row = await QuoteCost.findOne({ where: { id: parseId(costId, "cost id"), quoteId: quote.id } });
    if (!row) throw httpError(404, "Quote cost not found");
    await row.destroy();
};

// ---- Generated versions -----------------------------------------------------
// A version is the quote frozen at the moment it was generated. The client
// sends the snapshot it rendered (see prestige-fe/src/helpers/invoice.js), the
// server owns the version number so two people generating at once cannot
// collide. Generating also locks the quote (status → generated).

const presentVersion = (row) => ({
    id: row.id,
    version: row.version,
    quoteNumber: row.quoteNumber,
    invoiceNumber: row.invoiceNumber,
    grandTotal: row.grandTotal === null ? null : Number(row.grandTotal),
    snapshot: row.snapshot ?? null,
    createdAt: row.createdAt,
    createdByName: row.createdBy?.name ?? null,
});

/**
 * A saved version's total without GST — the figure the pipeline counts (its
 * screens show "ex GST"). Read off the version itself: under "exclusive" GST
 * was added on top of the pre-tax total, under "inclusive" it is inside it,
 * and either way the pre-tax figure is the total ÷ (1 + rate); "no_gst" has
 * none. A version without its quote in the snapshot is taken as the default
 * quote (GST exclusive at 10 %). Null when there is no total.
 */
export const exGstTotalOf = (version) => {
    const total = Number(version?.grandTotal);
    if (version?.grandTotal === null || version?.grandTotal === undefined || !Number.isFinite(total)) return null;
    const quote = version?.snapshot?.quote ?? {};
    if (quote.taxTreatment === "no_gst") return Math.round(total * 100) / 100;
    const rate = Number(quote.gstRatePct ?? 10);
    const exGst = Number.isFinite(rate) && rate > 0 ? total / (1 + rate / 100) : total;
    return Math.round(exGst * 100) / 100;
};

/** Generated versions for this opportunity, newest first. */
export const listVersions = async (id) => {
    const opportunityId = parseId(id, "opportunity id");
    const rows = await QuoteVersion.findAll({
        where: { opportunityId },
        include: [VERSION_CREATOR],
        order: [["version", "DESC"], ["id", "DESC"]],
    });
    return rows.map(presentVersion);
};

/**
 * JSON with object keys sorted, so a snapshot that came back out of JSONB
 * (keys re-ordered) still compares equal to the one the client just built.
 * The same comparison the client makes (helpers/invoice.js#matchesSnapshot).
 */
const stableJson = (value) =>
    JSON.stringify(value, (key, inner) =>
        inner && typeof inner === "object" && !Array.isArray(inner)
            ? Object.fromEntries(Object.keys(inner).sort().map((k) => [k, inner[k]]))
            : inner
    );

const sameQuote = (snapshot, version) =>
    Boolean(version?.snapshot?.quote) && stableJson(snapshot?.quote ?? null) === stableJson(version.snapshot.quote);

/**
 * Generates the quote: { snapshot, quoteNumber?, grandTotal?, version? } →
 * the new version, with the quote (now locked) as `quote`. `version` in the
 * body is a hint only — numbering is the server's.
 *
 * A draft that is unchanged from the version it was started from (same
 * snapshot.quote as the newest version) is locked back onto that version
 * instead of making a duplicate — the way to cancel a new quote nothing was
 * done with. A quote that is already generated is refused: start a new one.
 */
export const createVersion = async (id, payload = {}, actor) => {
    const opportunity = await loadOpportunity(id);
    if (!opportunity) throw httpError(404, "Opportunity not found");
    const quote = await findQuote(opportunity.id);
    if (!quote) throw httpError(400, "Create the quote before generating it");
    if (isGenerated(quote))
        throw httpError(
            409,
            `This quote has already been generated${quote.generatedVersion ? ` as version ${quote.generatedVersion.version}` : ""} — create a new quote to generate another version`
        );
    if (!quote.items?.length) throw httpError(400, "Add at least one item before generating the quote");

    const snapshot = payload.snapshot;
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot))
        throw httpError(400, "snapshot is required");

    const { version, reused } = await sequelize.transaction(async (transaction) => {
        const newest = await QuoteVersion.findOne({ where: { quoteId: quote.id }, order: [["version", "DESC"], ["id", "DESC"]], transaction });
        if (newest && sameQuote(snapshot, newest)) {
            await quote.update({ status: "generated", generatedAt: newest.createdAt, generatedVersionId: newest.id }, { transaction });
            return { version: newest, reused: true };
        }
        // Numbering is the server's: whatever the client guessed, the next
        // version is one past the highest this quote already has.
        const created = await QuoteVersion.create(
            {
                quoteId: quote.id,
                opportunityId: opportunity.id,
                version: (newest?.version ?? 0) + 1,
                quoteNumber: text(payload.quoteNumber || quote.quoteNumber, 40) || null,
                grandTotal: num(payload.grandTotal ?? snapshot.grandTotal),
                snapshot,
                createdById: actor?.id ?? null,
            },
            { transaction }
        );
        await quote.update({ status: "generated", generatedAt: created.createdAt, generatedVersionId: created.id }, { transaction });
        return { version: created, reused: false };
    });

    if (!reused) {
        // The job is worth what it was last priced at, until a customer accepts
        // a figure (proposalService sets acceptedValue then). Without this
        // nothing wrote estimatedValue, and every pipeline value read $0.
        const estimate = exGstTotalOf(version);
        if (estimate !== null) await opportunity.update({ estimatedValue: estimate });
        await recordSystemEvent(
            opportunity,
            `Quote ${version.quoteNumber || quote.quoteNumber} generated as version ${version.version}${version.grandTotal !== null ? ` (${money(version.grandTotal)})` : ""} — locked.`,
            actor
        );
    } else {
        await recordSystemEvent(opportunity, `New quote cancelled — nothing changed, ${quote.quoteNumber} stays at version ${version.version}.`, actor);
    }

    const row = await QuoteVersion.findByPk(version.id, { include: [VERSION_CREATOR] });
    return { ...presentVersion(row), quote: presentQuote(await findQuote(opportunity.id), opportunity) };
};

/**
 * Starts a new quote from the generated one: the lock comes off and the quote
 * is a draft again, pre-filled with everything the generated version holds
 * (the same rows — nothing is copied). Generating it makes the next version.
 */
export const startDraft = async (id, actor) => {
    const { opportunity, quote } = await loadQuoteFor(id);
    if (!isGenerated(quote)) throw httpError(409, "This quote is still a draft — edit it, or generate it first");
    const from = quote.generatedVersion;
    await quote.update({ status: "draft", generatedAt: null, generatedVersionId: null });
    await recordSystemEvent(
        opportunity,
        `New quote started from ${quote.quoteNumber}${from ? ` version ${from.version}` : ""} — a draft again, generating it makes version ${(from?.version ?? 0) + 1}.`,
        actor
    );
    return presentQuote(await findQuote(opportunity.id), opportunity);
};
