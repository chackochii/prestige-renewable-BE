// Master config for business units. Billing split percentages, referrer
// commission tiers, approval types, enabled stages, substages, SLAs and the
// margin floor are all editable per unit at runtime — models validate against
// this config, not hardcoded lists.
import db from "../../../models/index.js";
import { disabledPageCodesByUnit } from "../../page/service/pageService.js";
import { SUPER_ROLE_CODE } from "../../role/service/roleService.js";
import { parseId } from "../../../utils/ids.js";

const { BusinessUnit, UserBusinessUnit, Opportunity } = db;

const UNIT_STATUSES = ["active", "configured", "inactive"];

// Must mirror Opportunity.involvementTier's allowed values
const COMMISSION_TIER_KEYS = ["lead_only", "lead_sales_support", "lead_full_sales"];

const httpError = (status, message) => Object.assign(new Error(message), { status });

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

const validateBillingSplit = (value) => {
    if (!Array.isArray(value) || value.length === 0)
        throw httpError(400, "billingSplit must be a non-empty array of { key, label, percent }");
    const keys = new Set();
    let total = 0;
    for (const item of value) {
        if (!isPlainObject(item) || typeof item.key !== "string" || !item.key.trim())
            throw httpError(400, "Each billing milestone needs a non-empty string key");
        // BillingRequest.milestone is STRING(20)
        if (item.key.length > 20) throw httpError(400, `Billing milestone key "${item.key}" exceeds 20 characters`);
        if (keys.has(item.key)) throw httpError(400, `Duplicate billing milestone key "${item.key}"`);
        keys.add(item.key);
        const percent = Number(item.percent);
        if (!Number.isFinite(percent) || percent <= 0 || percent > 100)
            throw httpError(400, `Billing milestone "${item.key}" needs a percent between 0 and 100`);
        total += percent;
    }
    if (Math.abs(total - 100) > 0.01)
        throw httpError(400, `Billing split percentages must sum to 100 (got ${total})`);
    return value.map((item) => ({ key: item.key, label: item.label ?? item.key, percent: Number(item.percent) }));
};

const validateCommissionTiers = (value) => {
    if (!Array.isArray(value))
        throw httpError(400, "commissionTiers must be an array of { key, label, rate }");
    const keys = new Set();
    for (const item of value) {
        if (!isPlainObject(item) || !COMMISSION_TIER_KEYS.includes(item.key))
            throw httpError(400, `Commission tier key must be one of: ${COMMISSION_TIER_KEYS.join(", ")}`);
        if (keys.has(item.key)) throw httpError(400, `Duplicate commission tier "${item.key}"`);
        keys.add(item.key);
        const rate = Number(item.rate);
        // Rate is a fraction, e.g. 0.02 = 2%
        if (!Number.isFinite(rate) || rate < 0 || rate > 1)
            throw httpError(400, `Commission tier "${item.key}" needs a rate between 0 and 1 (fraction)`);
    }
    return value.map((item) => ({ key: item.key, label: item.label ?? item.key, rate: Number(item.rate) }));
};

const validateKeyLabelList = (value, field, maxKeyLength) => {
    if (!Array.isArray(value)) throw httpError(400, `${field} must be an array of { key, label }`);
    const keys = new Set();
    for (const item of value) {
        if (!isPlainObject(item) || typeof item.key !== "string" || !item.key.trim())
            throw httpError(400, `Each ${field} entry needs a non-empty string key`);
        if (item.key.length > maxKeyLength)
            throw httpError(400, `${field} key "${item.key}" exceeds ${maxKeyLength} characters`);
        if (keys.has(item.key)) throw httpError(400, `Duplicate ${field} key "${item.key}"`);
        keys.add(item.key);
    }
    return value.map((item) => ({ key: item.key, label: item.label ?? item.key }));
};

// Approval.type is STRING(20); empty array = unit has no approvals section
const validateApprovalTypes = (value) => validateKeyLabelList(value, "approvalTypes", 20);

// SiteWorkSubstage.key is STRING(5); empty array = unit skips site works
const validateSiteWorkSubstages = (value) => validateKeyLabelList(value, "siteWorkSubstages", 5);

const validateEnabledStages = (value) => {
    if (!Array.isArray(value) || value.length === 0)
        throw httpError(400, "enabledStages must be a non-empty array of stage numbers 1-9");
    const stages = value.map(Number);
    if (stages.some((s) => !Number.isInteger(s) || s < 1 || s > 9))
        throw httpError(400, "enabledStages values must be integers between 1 and 9");
    if (new Set(stages).size !== stages.length) throw httpError(400, "enabledStages contains duplicates");
    return stages.sort((a, b) => a - b);
};

const validateSlaDays = (value) => {
    if (!isPlainObject(value)) throw httpError(400, "slaDays must be an object keyed by stage number or 'approval'");
    for (const [key, days] of Object.entries(value)) {
        const stage = Number(key);
        if (key !== "approval" && (!Number.isInteger(stage) || stage < 1 || stage > 9))
            throw httpError(400, `slaDays key "${key}" must be a stage number 1-9 or "approval"`);
        if (!Number.isFinite(Number(days)) || Number(days) < 0)
            throw httpError(400, `slaDays["${key}"] must be a non-negative number of days`);
    }
    return value;
};

const validateMarginFloor = (value) => {
    const floor = Number(value);
    if (!Number.isFinite(floor) || floor < 0 || floor > 100)
        throw httpError(400, "marginFloor must be a number between 0 and 100");
    return floor;
};

// Free-form per-unit data; any JSON object is accepted
const validateMetadata = (value) => {
    if (!isPlainObject(value)) throw httpError(400, "metadata must be an object");
    return value;
};

const CONFIG_VALIDATORS = {
    billingSplit: validateBillingSplit,
    commissionTiers: validateCommissionTiers,
    approvalTypes: validateApprovalTypes,
    siteWorkSubstages: validateSiteWorkSubstages,
    enabledStages: validateEnabledStages,
    slaDays: validateSlaDays,
    marginFloor: validateMarginFloor,
    metadata: validateMetadata,
};

// Returns only the recognised config fields from payload, validated & normalised
const validateConfig = (payload) => {
    const updates = {};
    for (const [field, validate] of Object.entries(CONFIG_VALIDATORS)) {
        if (payload[field] !== undefined) updates[field] = validate(payload[field]);
    }
    return updates;
};

// Each unit carries disabledPages (registry page codes turned off for it) so
// the frontend sidebar can filter per unit without a request per unit.
//
// Access is deny-by-default: a user only sees the units assigned to them
// (user_business_units); ADM sees every unit. Passing no user (internal
// callers) also returns everything.
export const listBusinessUnits = async (user = null) => {
    const where = {};
    if (user && !(user.roles ?? []).includes(SUPER_ROLE_CODE)) {
        const links = await UserBusinessUnit.findAll({
            where: { userId: user.id },
            attributes: ["businessUnitId"],
        });
        where.id = links.map((link) => link.businessUnitId);
    }

    const [units, disabledByUnit] = await Promise.all([
        BusinessUnit.findAll({ where, order: [["code", "ASC"]] }),
        disabledPageCodesByUnit(),
    ]);
    return units.map((unit) => ({
        ...unit.get({ plain: true }),
        disabledPages: disabledByUnit.get(unit.id) ?? [],
    }));
};

export const getBusinessUnit = async (id) => {
    const unit = await BusinessUnit.findByPk(parseId(id, "business unit id"));
    if (!unit) throw httpError(404, "Business unit not found");
    return unit;
};

export const createBusinessUnit = async (payload) => {
    if (typeof payload?.code !== "string" || !payload.code.trim())
        throw httpError(400, "code is required");
    if (typeof payload?.name !== "string" || !payload.name.trim())
        throw httpError(400, "name is required");

    const existing = await BusinessUnit.findOne({ where: { code: payload.code } });
    if (existing) throw httpError(409, `Business unit code "${payload.code}" already exists`);

    return BusinessUnit.create({
        code: payload.code.trim(),
        name: payload.name.trim(),
        legalName: payload.legalName,
        timezone: payload.timezone,
        status: payload.status,
        ...validateConfig(payload), // omitted fields fall back to model defaults (full solar workflow)
    });
};

// Core identity fields, superadmin-only. Codes are immutable (opportunity
// numbers and reporting key off them); workflow config has its own endpoint.
export const updateBusinessUnit = async (id, payload = {}) => {
    const unit = await getBusinessUnit(id);
    if (payload.code !== undefined && payload.code !== unit.code)
        throw httpError(400, "Business unit codes are immutable");

    const updates = {};
    if (payload.name !== undefined) {
        if (typeof payload.name !== "string" || !payload.name.trim())
            throw httpError(400, "name must be a non-empty string");
        updates.name = payload.name.trim();
    }
    if (payload.legalName !== undefined) updates.legalName = payload.legalName ?? null;
    if (payload.timezone !== undefined) {
        if (typeof payload.timezone !== "string" || !payload.timezone.trim())
            throw httpError(400, "timezone must be a non-empty string");
        updates.timezone = payload.timezone.trim();
    }
    if (payload.status !== undefined) {
        if (!UNIT_STATUSES.includes(payload.status))
            throw httpError(400, `status must be one of: ${UNIT_STATUSES.join(", ")}`);
        updates.status = payload.status;
    }
    if (Object.keys(updates).length === 0)
        throw httpError(400, "No fields provided. Editable: name, legalName, timezone, status");

    return unit.update(updates);
};

// Superadmin-only, and only for units with no trading history — a unit that
// has opportunities (even soft-deleted ones) is deactivated, never removed.
// User assignments and page overrides cascade.
export const deleteBusinessUnit = async (id) => {
    const unit = await getBusinessUnit(id);
    const opportunities = await Opportunity.count({
        where: { businessUnitId: unit.id },
        paranoid: false,
    });
    if (opportunities > 0)
        throw httpError(
            409,
            `"${unit.code}" has ${opportunities} opportunit${opportunities === 1 ? "y" : "ies"} — set its status to inactive instead of deleting it`
        );
    await unit.destroy();
};

// Just the unit's master-config section (the editable fields), no entity noise
export const getBusinessUnitConfig = async (id) => {
    const unit = await getBusinessUnit(id);
    const config = {};
    for (const field of Object.keys(CONFIG_VALIDATORS)) config[field] = unit[field];
    return { id: unit.id, code: unit.code, name: unit.name, ...config };
};

// Partial update: only the config fields present in the payload are changed.
// Existing opportunities are unaffected — they snapshot config where needed
// (e.g. marginFloor) or keep already-seeded rows (approvals, billing requests).
export const updateBusinessUnitConfig = async (id, payload) => {
    const unit = await getBusinessUnit(id);
    const updates = validateConfig(payload);
    if (Object.keys(updates).length === 0)
        throw httpError(400, `No config fields provided. Editable: ${Object.keys(CONFIG_VALIDATORS).join(", ")}`);
    return unit.update(updates);
};
