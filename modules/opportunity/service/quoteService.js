// The quote built at the estimation stage: one per opportunity, line items
// priced from the catalog (copied at add time) and additional costs. Totals
// and GST are derived by the client — nothing here stores a total.
import db from "../../../models/index.js";
import { parseId } from "../../../utils/ids.js";
import { PROJECT_TYPES, TAX_TREATMENTS } from "../model/quote.js";
import { COST_CALC_TYPES } from "../model/quoteCost.js";

const { Opportunity, Quote, QuoteItem, QuoteCost, CatalogItem, User } = db;

const httpError = (status, message) => Object.assign(new Error(message), { status });

const num = (value) => (value === null || value === undefined || value === "" ? null : Number(value));
const text = (value, max) => String(value ?? "").trim().slice(0, max);

const loadOpportunity = async (id) =>
    Opportunity.findByPk(parseId(id, "opportunity id"), {
        include: [{ model: User, as: "estimator", attributes: ["id", "name"] }],
    });

const QUOTE_INCLUDE = [
    { model: QuoteItem, as: "items" },
    { model: QuoteCost, as: "additionalCosts" },
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
    createdAt: quote.createdAt,
    updatedAt: quote.updatedAt,
});

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
    await Quote.create({
        opportunityId: opportunity.id,
        quoteNumber: quoteNumberFor(opportunity),
        quoteDate: new Date().toISOString().slice(0, 10),
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

/** { project?, projectType?, projectTypeOther?, quoteDate?, taxTreatment?, gstRatePct? } */
export const updateQuote = async (id, payload = {}) => {
    const { opportunity, quote } = await loadQuoteFor(id);
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
    const fields = await itemFields(payload);
    const row = await QuoteItem.create({ ...fields, quoteId: quote.id, sortOrder: (quote.items || []).length });
    return presentItem(row);
};

export const updateItem = async (id, itemId, payload = {}) => {
    const { quote } = await loadQuoteFor(id);
    const row = await QuoteItem.findOne({ where: { id: parseId(itemId, "item id"), quoteId: quote.id } });
    if (!row) throw httpError(404, "Quote item not found");
    await row.update(await itemFields(payload, { partial: true }));
    return presentItem(row);
};

export const removeItem = async (id, itemId) => {
    const { quote } = await loadQuoteFor(id);
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
        const calcType = fields.calcType ?? current?.calcType ?? "fixed";
        if (calcType === "percentage" && value > 100) throw httpError(400, "A percentage cost cannot exceed 100%");
        fields.value = value;
    }
    if (has("description")) fields.description = text(payload.description, 500) || null;
    return fields;
};

export const addCost = async (id, payload = {}) => {
    const { quote } = await loadQuoteFor(id);
    const fields = costFields(payload);
    const row = await QuoteCost.create({ ...fields, quoteId: quote.id, sortOrder: (quote.additionalCosts || []).length });
    return presentCost(row);
};

export const updateCost = async (id, costId, payload = {}) => {
    const { quote } = await loadQuoteFor(id);
    const row = await QuoteCost.findOne({ where: { id: parseId(costId, "cost id"), quoteId: quote.id } });
    if (!row) throw httpError(404, "Quote cost not found");
    await row.update(costFields(payload, row));
    return presentCost(row);
};

export const removeCost = async (id, costId) => {
    const { quote } = await loadQuoteFor(id);
    const row = await QuoteCost.findOne({ where: { id: parseId(costId, "cost id"), quoteId: quote.id } });
    if (!row) throw httpError(404, "Quote cost not found");
    await row.destroy();
};
