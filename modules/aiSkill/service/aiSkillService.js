// AI skills: the instructions the AI works to, maintained by admins.
//
// A skill holds three things, all editable on Admin → AI skills:
//   content     the main instructions (the skill's SKILL.md) — typed in, or an
//               uploaded .md file
//   references  extra files the AI reads with it (methodology.md, worked
//               examples as JSON, calc.py) — uploaded, viewed, removed
//   settings    the calculator's figures (products and prices, certificate
//               prices, network loss factors, STC zones, finance, savings
//               assumptions) — merged over the code's defaults
//               (energyProposal/service/proposalDefaults.js)
//
// Every save writes a new version (ai_skill_versions) with who and why, so an
// edit can be compared and rolled back. The energy proposal reads the active
// skill of its purpose when it asks the AI (energyProposalService).
import { Op } from "sequelize";
import db from "../../../models/index.js";
import { parseId } from "../../../utils/ids.js";
import { multiLine, oneLine } from "../../../utils/text.js";
import { recordActivity } from "../../activity/service/activityService.js";
import { BATTERY_MODELS, DEFAULT_SETTINGS, DISCHARGE_ORDERS, FINANCE_MODES, PRODUCT_KINDS, mergeSettings } from "../../energyProposal/service/proposalDefaults.js";
import { SKILL_PURPOSES } from "../model/aiSkill.js";

const { AiSkill, AiSkillVersion, User, sequelize } = db;

const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

/** Limits that keep a skill a size the AI can take with every request. */
export const LIMITS = {
    contentChars: 200_000,
    referenceChars: 300_000,
    references: 20,
    totalReferenceChars: 600_000,
};
/** Files a skill can be made of: text the AI can read. */
export const SKILL_FILE_EXTENSIONS = ["md", "markdown", "txt", "json", "py", "csv", "yaml", "yml"];

const brief = (u) => (u ? { id: u.id, name: u.name } : null);

/** The settings a skill's calculator uses: what the admin saved, over the defaults. */
export const effectiveSettings = (skill) => mergeSettings(DEFAULT_SETTINGS, skill?.settings ?? {});

const presentReference = (ref, { withContent = false } = {}) => ({
    name: ref.name,
    size: ref.size ?? (ref.content ? ref.content.length : 0),
    uploadedAt: ref.uploadedAt ?? null,
    uploadedBy: ref.uploadedBy ?? null,
    ...(withContent ? { content: ref.content ?? "" } : {}),
});

export const presentSkill = (row, { withContent = true } = {}) => ({
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description ?? null,
    purpose: row.purpose,
    isActive: row.isActive,
    version: row.version,
    ...(withContent ? { content: row.content } : { contentLength: row.content?.length ?? 0 }),
    references: (row.references ?? []).map((ref) => presentReference(ref)),
    settings: effectiveSettings(row),
    defaults: withContent ? DEFAULT_SETTINGS : undefined,
    updatedBy: brief(row.updatedBy),
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
});

const INCLUDE = [{ model: User, as: "updatedBy", attributes: ["id", "name"] }];

const findSkill = async (id) => {
    const row = await AiSkill.findByPk(parseId(id, "skill id"), { include: INCLUDE });
    if (!row) throw httpError(404, "Skill not found");
    return row;
};

// ---- Cleaning what the admin sends -----------------------------------------------

const cleanContent = (value) => {
    if (typeof value !== "string") throw httpError(400, "content must be text");
    const text = value.replace(/\r\n?/g, "\n").replace(/\u0000/g, "");
    if (!text.trim()) throw httpError(400, "The skill's instructions cannot be empty");
    if (text.length > LIMITS.contentChars) throw httpError(400, `The skill's instructions are too long (${LIMITS.contentChars.toLocaleString()} characters max)`);
    return text;
};

const cleanFileName = (value) => {
    const name = oneLine(String(value ?? "").split(/[\\/]/).pop(), 120).replace(/[^\w.\- ()]+/g, "_");
    if (!name) throw httpError(400, "The file needs a name");
    const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
    if (!SKILL_FILE_EXTENSIONS.includes(ext)) throw httpError(400, `A skill file must be text: ${SKILL_FILE_EXTENSIONS.map((e) => `.${e}`).join(", ")}`);
    return name;
};

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const finiteIn = (value, label, min, max) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < min || n > max) throw httpError(400, `${label} must be a number between ${min} and ${max}`);
    return n;
};

/**
 * Validates the parts of the settings the calculator depends on; anything
 * else (texts, company details) is kept as sent. Returns the settings to store.
 */
export const cleanSettings = (value) => {
    if (!isPlainObject(value)) throw httpError(400, "settings must be an object");
    const merged = mergeSettings(DEFAULT_SETTINGS, value);
    const inc = merged.incentives;
    finiteIn(merged.gstRatePct, "GST rate", 0, 50);
    finiteIn(inc.prcPrice, "PRC price", 0, 100);
    finiteIn(inc.stcPrice, "STC price", 0, 200);
    finiteIn(inc.usableFraction, "Usable fraction", 0.1, 1);
    finiteIn(inc.minSolarToUsableRatio, "Minimum solar to usable ratio", 0, 5);
    finiteIn(inc.defaultNlf, "Default network loss factor", 0.5, 2);
    for (const [network, nlf] of Object.entries(inc.nlf ?? {})) finiteIn(nlf, `Network loss factor for ${network}`, 0.5, 2);
    if (!Array.isArray(inc.bess4?.tiers) || !inc.bess4.tiers.length) throw httpError(400, "BESS4 needs at least one tier");
    inc.bess4.tiers.forEach((t, i) => {
        finiteIn(t.fromKwh, `BESS4 tier ${i + 1} from`, 0, 100000);
        finiteIn(t.toKwh, `BESS4 tier ${i + 1} to`, 0, 100000);
        finiteIn(t.kwPerKwh, `BESS4 tier ${i + 1} kW per kWh`, 0, 10);
    });
    finiteIn(inc.bess5?.kwPerKwh, "BESS5 kW per kWh", 0, 10);
    finiteIn(inc.batteryStc?.factor, "Battery STC factor", 0, 100);
    (inc.batteryStc?.tiers ?? []).forEach((t, i) => {
        finiteIn(t.fromKwh, `Battery STC tier ${i + 1} from`, 0, 100000);
        finiteIn(t.toKwh, `Battery STC tier ${i + 1} to`, 0, 100000);
        finiteIn(t.share, `Battery STC tier ${i + 1} share`, 0, 1);
    });
    finiteIn(inc.solarStc?.deemingYears, "Solar STC deeming years", 0, 15);
    finiteIn(inc.solarStc?.maxKw, "Solar STC limit (kW)", 0, 10000);
    for (const [zone, factor] of Object.entries(inc.solarStc?.zones ?? {})) finiteIn(factor, `STC zone ${zone} factor`, 0, 5);
    const f = merged.finance;
    if (!FINANCE_MODES.includes(f.mode)) throw httpError(400, `finance mode must be one of: ${FINANCE_MODES.join(", ")}`);
    finiteIn(f.financePct, "Finance %", 0, 100);
    finiteIn(f.upfrontPct, "Upfront %", 0, 100);
    finiteIn(f.months, "Months", 1, 120);
    if (!Array.isArray(f.milestones) || !f.milestones.length) throw httpError(400, "Option B needs at least one milestone");
    const pct = f.milestones.reduce((s, m) => s + finiteIn(m.pct, "Milestone %", 0, 100), 0);
    if (Math.abs(pct - 100) > 0.001) throw httpError(400, `Option B milestones must add up to 100% (they add up to ${pct}%)`);
    const s = merged.savings;
    if (!Array.isArray(s.yieldProfile) || s.yieldProfile.length !== 12) throw httpError(400, "The solar yield profile needs 12 monthly figures");
    s.yieldProfile.forEach((v, i) => finiteIn(v, `Solar yield month ${i + 1}`, 0, 400));
    finiteIn(s.solarWindowSharePct, "Solar-window load %", 0, 100);
    finiteIn(s.batteryEfficiencyPct, "Battery round-trip efficiency %", 10, 100);
    if (!DISCHARGE_ORDERS.includes(s.dischargeOrder)) throw httpError(400, `discharge order must be one of: ${DISCHARGE_ORDERS.join(", ")}`);
    if (!BATTERY_MODELS.includes(s.batteryModel)) throw httpError(400, `battery model must be one of: ${BATTERY_MODELS.join(", ")}`);
    finiteIn(s.emissionsKgPerKwh, "Emissions factor", 0, 5);
    if (!Array.isArray(merged.products)) throw httpError(400, "products must be a list");
    const keys = new Set();
    merged.products = merged.products.map((p, i) => {
        if (!isPlainObject(p)) throw httpError(400, `Product ${i + 1} must be an object`);
        const key = oneLine(p.key, 60) || `product_${i + 1}`;
        if (keys.has(key)) throw httpError(400, `Product key "${key}" is used twice`);
        keys.add(key);
        if (!PRODUCT_KINDS.includes(p.kind)) throw httpError(400, `Product "${key}" needs a kind: ${PRODUCT_KINDS.join(", ")}`);
        if (!oneLine(p.name, 200)) throw httpError(400, `Product "${key}" needs a name`);
        finiteIn(p.priceExGst ?? 0, `Price of "${key}"`, 0, 10_000_000);
        return { ...p, key, name: oneLine(p.name, 200), description: Array.isArray(p.description) ? p.description.map((d) => oneLine(d, 200)).filter(Boolean).slice(0, 8) : [] };
    });
    return merged;
};

// ---- Versions ---------------------------------------------------------------------

const snapshot = (row, note, actor, transaction) =>
    AiSkillVersion.create(
        { skillId: row.id, version: row.version, name: row.name, content: row.content, references: row.references, settings: row.settings, note: note || null, editedById: actor?.id ?? null },
        { transaction }
    );

/** Applies changes, bumps the version, keeps the new state as a version — all or nothing. */
const saveVersion = async (row, changes, { note, actor, ctx, action }) => {
    await sequelize.transaction(async (transaction) => {
        const locked = await AiSkill.findByPk(row.id, { transaction, lock: transaction.LOCK.UPDATE });
        await locked.update({ ...changes, version: locked.version + 1, updatedById: actor?.id ?? null }, { transaction });
        await snapshot(locked, note, actor, transaction);
    });
    const fresh = await findSkill(row.id);
    await recordActivity({ actor, ctx, entityType: "ai_skill", entityId: fresh.id, entityLabel: fresh.name, action, meta: { version: fresh.version, note: note || null, fields: Object.keys(changes) } });
    return fresh;
};

// ---- Reads ----------------------------------------------------------------------

export const listSkills = async () => {
    const rows = await AiSkill.findAll({ include: INCLUDE, order: [["purpose", "ASC"], ["name", "ASC"]] });
    return rows.map((row) => presentSkill(row, { withContent: false }));
};

export const getSkill = async (id) => presentSkill(await findSkill(id));

/** The active skill for a purpose — what the proposal flow reads. Null when none is set up. */
export const activeSkillFor = (purpose) => AiSkill.findOne({ where: { purpose, isActive: true }, order: [["updatedAt", "DESC"]] });

export const getReference = async (id, name) => {
    const row = await findSkill(id);
    const ref = (row.references ?? []).find((r) => r.name === name);
    if (!ref) throw httpError(404, "Reference file not found");
    return presentReference(ref, { withContent: true });
};

export const listVersions = async (id) => {
    const row = await findSkill(id);
    const versions = await AiSkillVersion.findAll({
        where: { skillId: row.id },
        include: [{ model: User, as: "editedBy", attributes: ["id", "name"] }],
        order: [["version", "DESC"]],
        attributes: { exclude: ["content", "references", "settings"] },
    });
    return versions.map((v) => ({ id: v.id, version: v.version, name: v.name, note: v.note ?? null, editedBy: brief(v.editedBy), at: v.createdAt, current: v.version === row.version }));
};

export const getVersion = async (id, version) => {
    const row = await findSkill(id);
    const v = await AiSkillVersion.findOne({ where: { skillId: row.id, version: Number(version) } });
    if (!v) throw httpError(404, "Version not found");
    return { version: v.version, name: v.name, note: v.note ?? null, content: v.content, references: (v.references ?? []).map((r) => presentReference(r)), settings: mergeSettings(DEFAULT_SETTINGS, v.settings), at: v.createdAt };
};

// ---- Writes -----------------------------------------------------------------------

/** { key, name, description?, purpose?, content, settings? } — a new skill. */
export const createSkill = async (payload = {}, actor, ctx) => {
    const key = oneLine(payload.key, 60).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
    if (!key) throw httpError(400, "key is required (e.g. energy-proposal-v2)");
    if (await AiSkill.findOne({ where: { key } })) throw httpError(409, `A skill with key "${key}" already exists`);
    const name = oneLine(payload.name, 120);
    if (!name) throw httpError(400, "name is required");
    const purpose = payload.purpose ?? "energy_proposal";
    if (!SKILL_PURPOSES.includes(purpose)) throw httpError(400, `purpose must be one of: ${SKILL_PURPOSES.join(", ")}`);
    const row = await sequelize.transaction(async (transaction) => {
        const created = await AiSkill.create(
            {
                key,
                name,
                description: multiLine(payload.description, 1000) || null,
                purpose,
                content: cleanContent(payload.content ?? ""),
                settings: payload.settings ? cleanSettings(payload.settings) : {},
                references: [],
                // A new skill starts inactive, so it never replaces the one in use by surprise.
                isActive: false,
                version: 1,
                updatedById: actor?.id ?? null,
            },
            { transaction }
        );
        await snapshot(created, "Created", actor, transaction);
        return created;
    });
    await recordActivity({ actor, ctx, entityType: "ai_skill", entityId: row.id, entityLabel: row.name, action: "created" });
    return getSkill(row.id);
};

/**
 * Any of { name, description, content, settings, isActive } plus a `note`
 * saying what changed. Activating a skill deactivates the others of its purpose.
 */
export const updateSkill = async (id, payload = {}, actor, ctx) => {
    const row = await findSkill(id);
    const changes = {};
    if (payload.name !== undefined) {
        changes.name = oneLine(payload.name, 120);
        if (!changes.name) throw httpError(400, "name cannot be empty");
    }
    if (payload.description !== undefined) changes.description = multiLine(payload.description, 1000) || null;
    if (payload.content !== undefined) changes.content = cleanContent(payload.content);
    if (payload.settings !== undefined) changes.settings = cleanSettings(payload.settings);
    if (payload.isActive !== undefined) changes.isActive = Boolean(payload.isActive);
    if (!Object.keys(changes).length) throw httpError(400, "No changes provided. Editable: name, description, content, settings, isActive");
    if (changes.isActive === false && row.isActive) {
        const others = await AiSkill.count({ where: { purpose: row.purpose, isActive: true } });
        if (others <= 1) throw httpError(409, "This is the only active skill for proposals — activate another one first");
    }
    const saved = await saveVersion(row, changes, { note: oneLine(payload.note, 500), actor, ctx, action: changes.settings ? "settings_updated" : "updated" });
    if (changes.isActive === true) await AiSkill.update({ isActive: false }, { where: { purpose: row.purpose, id: { [Op.ne]: row.id } } });
    return presentSkill(saved);
};

/** Puts the settings back to the code's defaults (a new version). */
export const resetSettings = (id, actor, ctx) => findSkill(id).then((row) => saveVersion(row, { settings: {} }, { note: "Settings reset to the defaults", actor, ctx, action: "settings_reset" })).then((r) => presentSkill(r));

/**
 * An uploaded text file (multer: { originalname, buffer, size }). target:
 * "content" replaces the main instructions; "reference" adds (or replaces, by
 * name) a reference file.
 */
export const uploadSkillFile = async (id, file, { target = "reference", note } = {}, actor, ctx) => {
    if (!file) throw httpError(400, 'Attach the file in the "file" field');
    const row = await findSkill(id);
    const name = cleanFileName(file.originalname);
    const text = Buffer.from(file.buffer).toString("utf8").replace(/\r\n?/g, "\n").replace(/\u0000/g, "");
    if (!text.trim()) throw httpError(400, `${name} is empty`);
    if (target === "content") {
        return presentSkill(await saveVersion(row, { content: cleanContent(text) }, { note: oneLine(note, 500) || `Instructions replaced from ${name}`, actor, ctx, action: "content_uploaded" }));
    }
    if (target !== "reference") throw httpError(400, "target must be content or reference");
    if (text.length > LIMITS.referenceChars) throw httpError(400, `${name} is too long for a reference (${LIMITS.referenceChars.toLocaleString()} characters max)`);
    const others = (row.references ?? []).filter((r) => r.name !== name);
    if (others.length >= LIMITS.references) throw httpError(400, `A skill holds at most ${LIMITS.references} reference files`);
    const total = others.reduce((s, r) => s + (r.content?.length ?? 0), 0) + text.length;
    if (total > LIMITS.totalReferenceChars) throw httpError(400, `The reference files together would be too long (${LIMITS.totalReferenceChars.toLocaleString()} characters max)`);
    const replacing = others.length !== (row.references ?? []).length;
    const ref = { name, content: text, size: text.length, uploadedAt: new Date().toISOString(), uploadedById: actor?.id ?? null, uploadedBy: actor?.name ?? null };
    return presentSkill(
        await saveVersion(row, { references: [...others, ref].sort((a, b) => a.name.localeCompare(b.name)) }, { note: oneLine(note, 500) || `${replacing ? "Replaced" : "Added"} reference ${name}`, actor, ctx, action: replacing ? "reference_replaced" : "reference_added" })
    );
};

/** A reference file edited in place: { content, note? }. */
export const updateReference = async (id, name, payload = {}, actor, ctx) => {
    const row = await findSkill(id);
    const refs = row.references ?? [];
    const index = refs.findIndex((r) => r.name === name);
    if (index < 0) throw httpError(404, "Reference file not found");
    if (typeof payload.content !== "string" || !payload.content.trim()) throw httpError(400, "content must be non-empty text");
    const content = payload.content.replace(/\r\n?/g, "\n");
    if (content.length > LIMITS.referenceChars) throw httpError(400, `The reference is too long (${LIMITS.referenceChars.toLocaleString()} characters max)`);
    const next = refs.map((r, i) => (i === index ? { ...r, content, size: content.length, uploadedAt: new Date().toISOString(), uploadedById: actor?.id ?? null, uploadedBy: actor?.name ?? null } : r));
    return presentSkill(await saveVersion(row, { references: next }, { note: oneLine(payload.note, 500) || `Edited reference ${name}`, actor, ctx, action: "reference_edited" }));
};

export const removeReference = async (id, name, actor, ctx) => {
    const row = await findSkill(id);
    const refs = row.references ?? [];
    if (!refs.some((r) => r.name === name)) throw httpError(404, "Reference file not found");
    return presentSkill(await saveVersion(row, { references: refs.filter((r) => r.name !== name) }, { note: `Removed reference ${name}`, actor, ctx, action: "reference_removed" }));
};

/** Makes an earlier version current again (as a new version — history is never rewritten). */
export const restoreVersion = async (id, version, actor, ctx) => {
    const row = await findSkill(id);
    const v = await AiSkillVersion.findOne({ where: { skillId: row.id, version: Number(version) } });
    if (!v) throw httpError(404, "Version not found");
    if (v.version === row.version) throw httpError(409, "That is already the current version");
    return presentSkill(await saveVersion(row, { name: v.name, content: v.content, references: v.references, settings: v.settings }, { note: `Restored version ${v.version}`, actor, ctx, action: "version_restored" }));
};

export const deleteSkill = async (id, actor, ctx) => {
    const row = await findSkill(id);
    if (row.isActive) throw httpError(409, "The active skill cannot be deleted — activate another one first");
    await row.destroy();
    await recordActivity({ actor, ctx, entityType: "ai_skill", entityId: row.id, entityLabel: row.name, action: "deleted" });
};

/**
 * The skill as the AI is given it: the instructions, then each reference file
 * under its name. Capped so a very large skill cannot crowd out the job.
 */
export const skillPromptText = (skill, { maxChars = 400_000 } = {}) => {
    if (!skill) return "";
    let text = `# Skill: ${skill.name} (version ${skill.version})\n\n${skill.content}`;
    for (const ref of skill.references ?? []) {
        const block = `\n\n---\n# Reference file: ${ref.name}\n\n${ref.content}`;
        if (text.length + block.length > maxChars) {
            text += `\n\n---\n(Reference file ${ref.name} left out: the skill is over the size the AI is sent.)`;
            continue;
        }
        text += block;
    }
    return text;
};
