// Energy proposals: the commercial Solar + BESS (+ EV) proposal on a job, in
// the Prestige template (cover, why solar + battery, energy profile, price and
// incentives, payment options and savings, conditions and acceptance, value
// adds, back page). The PDF is built in the browser from what this returns.
//
// How one is made:
//   1. Draft with AI — the bills on the job (or ones chosen) and the
//      estimator's instructions go to the AI with the admin's skill; it fills
//      in the calculator's input (draftInput). Or start blank from the job.
//   2. The calculator works out every figure (proposalCalculator) with the
//      skill's settings, and flags the open items.
//   3. The words: written from the figures (proposalNarrative), optionally
//      rewritten by the AI to the skill (writeNarrative), and editable.
//   4. The estimator corrects anything — every save recalculates — then marks
//      it final (locked). Marking it final also saves it as the next version
//      of the job's quote (snapshot kind "energy_proposal"), so the proposal
//      stage sends it exactly as a manual quote is sent: Senior Sales approval
//      where the unit needs it, the customer's link showing this PDF, their
//      acceptance and the job's value. The PDF can be saved to the documents.
// A final proposal is changed by making a new revision of it (finalising the
// revision saves another version).
import { Op } from "sequelize";
import db from "../../../models/index.js";
import storage from "../../../utils/storage.js";
import logger from "../../../utils/logger.js";
import { parseId } from "../../../utils/ids.js";
import { multiLine, oneLine } from "../../../utils/text.js";
import { unitDate } from "../../../utils/unitTime.js";
import { LLM_FILE_TYPES, llmConfigured } from "../../../utils/llm.js";
import { recordActivity } from "../../activity/service/activityService.js";
import { activeSkillFor, effectiveSettings } from "../../aiSkill/service/aiSkillService.js";
import { recordSystemEvent } from "../../opportunity/service/leadWorkflowService.js";
import { addDocuments, extensionOf, MIME_BY_EXTENSION, presentDocument } from "../../opportunity/service/leadAttachmentService.js";
import { exGstTotalOf } from "../../opportunity/service/quoteService.js";
import { calculateProposal } from "./proposalCalculator.js";
import { cleanInput, calculatorInput } from "./proposalInput.js";
import { EDITABLE_NARRATIVE, LIST_NARRATIVE, defaultNarrative, effectiveNarrative, fixedText, shortClientName } from "./proposalNarrative.js";
import { draftInput, narrativeFigures, writeNarrative, billFile } from "./proposalAi.js";

const { EnergyProposal, Opportunity, BusinessUnit, User, Document, Quote, QuoteVersion, sequelize } = db;

const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

const PURPOSE = "energy_proposal";
const MAX_BILLS = 4;
const MAX_BILL_BYTES = 12 * 1024 * 1024; // together — they are sent inline with the request
const NUMBERING_LOCK_KEY = 4;

const brief = (u) => (u ? { id: u.id, name: u.name } : null);
const INCLUDE = [
    { model: User, as: "createdBy", attributes: ["id", "name"] },
    { model: User, as: "updatedBy", attributes: ["id", "name"] },
    { model: User, as: "finalisedBy", attributes: ["id", "name"] },
    { model: Document, as: "document", attributes: ["id", "name", "storageUrl", "url", "opportunityId", "createdAt"] },
    { model: QuoteVersion, as: "quoteVersion", attributes: ["id", "version", "quoteNumber", "grandTotal", "createdAt"] },
];
const versionBrief = (v) => (v ? { id: v.id, version: v.version, quoteNumber: v.quoteNumber, grandTotal: v.grandTotal === null ? null : Number(v.grandTotal), createdAt: v.createdAt } : null);

// ---- Loading ---------------------------------------------------------------------

const loadOpportunity = async (id) => {
    const opportunity = await Opportunity.findByPk(parseId(id, "opportunity id"), {
        include: [{ model: User, as: "salesperson", attributes: ["id", "name"] }],
    });
    if (!opportunity) throw httpError(404, "Opportunity not found");
    return opportunity;
};

const loadProposal = async (opportunity, proposalId) => {
    const row = await EnergyProposal.findOne({ where: { id: parseId(proposalId, "proposal id"), opportunityId: opportunity.id }, include: INCLUDE });
    if (!row) throw httpError(404, "Proposal not found");
    return row;
};

/** The skill the proposal is worked to: its own (when still there), else the active one. */
const skillFor = async (row = null) => {
    const skill = row?.skillId ? await db.AiSkill.findByPk(row.skillId) : null;
    return skill ?? (await activeSkillFor(PURPOSE));
};

// ---- Presenting -------------------------------------------------------------------

/**
 * Everything the screen and the PDF need: the input, the figures, the words
 * (the defaults, what was set over them, and the result the PDF prints), and
 * the company and dates for the document.
 */
const present = (row, { opportunity, unit, skill, settings }) => {
    const input = row.input ?? {};
    // A draft is always shown on the skill's current settings (an admin may
    // have changed a certificate price); a final proposal keeps the figures it
    // was finalised with.
    const result = row.status === "final" && row.result ? row.result : calculateProposal(calculatorInput(input), settings);
    const narrative = row.narrative ?? {};
    const company = { ...settings.company, name: settings.company.name || unit?.legalName || unit?.name };
    return {
        id: row.id,
        opportunityId: row.opportunityId,
        number: row.number,
        revision: row.revision,
        title: row.title,
        status: row.status,
        preparedOn: row.preparedOn,
        validUntil: row.validUntil,
        input,
        result,
        narrative,
        text: effectiveNarrative({ input, result, settings, narrative }),
        // The default words, with the default exclusions (the editor shows them greyed).
        defaults: draftWords({ input, result, settings }),
        document: {
            company,
            brand: unit?.brand ?? "prestige",
            preparedBy: settings.company.preparedBy || opportunity?.salesperson?.name || row.createdBy?.name || null,
            clientShort: shortClientName(input.client?.name) || opportunity?.customerTradingName || opportunity?.customerLegalName || "Client",
            jobNumber: opportunity?.number ?? null,
        },
        skill: skill ? { id: skill.id, name: skill.name, version: row.skillVersion ?? skill.version, currentVersion: skill.version } : null,
        ai: row.ai ?? null,
        pdf: row.document ? presentDocument(row.document) : null,
        // The quote version it was saved as when marked final — what goes to the customer.
        quoteVersion: versionBrief(row.quoteVersion),
        createdBy: brief(row.createdBy),
        updatedBy: brief(row.updatedBy),
        finalisedBy: brief(row.finalisedBy),
        finalisedAt: row.finalisedAt ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
};

const presentFull = async (row, opportunity) => {
    const [unit, skill] = await Promise.all([BusinessUnit.findByPk(row.businessUnitId), skillFor(row)]);
    return present(row, { opportunity, unit, skill, settings: effectiveSettings(skill) });
};

const summary = (row) => ({
    id: row.id,
    number: row.number,
    revision: row.revision,
    title: row.title,
    status: row.status,
    preparedOn: row.preparedOn,
    netIncGst: row.result?.net?.incGst ?? null,
    totalIncGst: row.result?.prices?.totalIncGst ?? null,
    annualBenefit: row.result?.savings?.annualBenefit ?? null,
    system: row.result?.system ? { nominalKwh: row.result.system.nominalKwh, solarKw: row.result.system.solarKw, evChargers: row.result.system.evChargers } : null,
    openItems: (row.result?.flags ?? []).length,
    pdf: row.document ? presentDocument(row.document) : null,
    quoteVersion: versionBrief(row.quoteVersion),
    createdBy: brief(row.createdBy),
    updatedAt: row.updatedAt,
});

// ---- What the job already knows -----------------------------------------------------

const siteAddressOf = (o) => [o.siteLine1, [o.siteSuburb, o.siteState, o.sitePostcode].filter(Boolean).join(" ")].filter(Boolean).join(", ");

const inputFromJob = (opportunity, settings) =>
    cleanInput(
        {
            client: { name: opportunity.customerLegalName || opportunity.customerTradingName, abn: opportunity.customerAbn },
            site: { address: siteAddressOf(opportunity), state: opportunity.siteState, stcZone: settings.incentives.solarStc.defaultZone },
            annualKwhOverride: opportunity.energyAnnualKwh ? Number(opportunity.energyAnnualKwh) : null,
            annualKwhBasis: opportunity.energyAnnualKwh ? "the annual usage recorded on the job" : null,
        },
        settings
    );

/** What the AI is told about the job — the business and the site, not the people. */
const jobBrief = (opportunity) => ({
    jobNumber: opportunity.number,
    client: { legalName: opportunity.customerLegalName, tradingName: opportunity.customerTradingName, abn: opportunity.customerAbn },
    site: { address: siteAddressOf(opportunity), state: opportunity.siteState, postcode: opportunity.sitePostcode },
    leadType: opportunity.leadType,
    requirement: opportunity.serviceRequirement,
    electricalPhase: opportunity.electricalPhase,
    roofType: opportunity.roofType,
    annualEnergyUseKwh: opportunity.energyAnnualKwh ? Number(opportunity.energyAnnualKwh) : null,
    energyNotes: opportunity.energyNotes,
    customerComments: opportunity.customerComments,
    siteSpecificRequirements: opportunity.siteSpecificRequirements,
    estimationInputs: opportunity.estimationInput ?? {},
});

// ---- Numbering ------------------------------------------------------------------------

/** QN + the unit's date + a 4-digit number for the day + suffix, e.g. QN202611060039-S. */
const nextNumber = async (unit, settings, transaction) => {
    const date = unitDate(unit).replace(/-/g, "");
    const prefix = `${settings.quote.prefix || "QN"}${date}`;
    await sequelize.query("SELECT pg_advisory_xact_lock(:key, 0)", { replacements: { key: NUMBERING_LOCK_KEY }, transaction });
    const rows = await EnergyProposal.findAll({ where: { number: { [Op.like]: `${prefix}%` } }, attributes: ["number"], transaction, raw: true });
    const highest = rows.map((r) => Number(String(r.number).slice(prefix.length, prefix.length + 4))).filter(Number.isInteger).reduce((m, x) => Math.max(m, x), 0);
    return `${prefix}${String(highest + 1).padStart(4, "0")}${settings.quote.suffix ?? "-S"}`;
};

const addDays = (iso, days) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
};

const titleFor = (result) =>
    [
        result.system.nominalKwh ? `${Math.round(result.system.nominalKwh * 10) / 10} kWh battery` : null,
        result.system.solarKw ? `${Math.round(result.system.solarKw * 100) / 100} kW solar` : null,
        result.system.evChargers && !result.system.evFuture ? `${result.system.evChargers} EV chargers` : null,
    ]
        .filter(Boolean)
        .join(" + ") + (result.system.evFuture ? " (EV-ready)" : "") || "Energy proposal";

// ---- Reads ----------------------------------------------------------------------------

export const listProposals = async (id) => {
    const opportunity = await loadOpportunity(id);
    const rows = await EnergyProposal.findAll({ where: { opportunityId: opportunity.id }, include: INCLUDE, order: [["createdAt", "DESC"], ["id", "DESC"]] });
    return rows.map(summary);
};

export const getProposal = async (id, proposalId) => {
    const opportunity = await loadOpportunity(id);
    return presentFull(await loadProposal(opportunity, proposalId), opportunity);
};

/** What the editor needs to offer: the skill in use, its products and settings, whether the AI is set up, the job's bills. */
export const proposalOptions = async (id) => {
    const opportunity = await loadOpportunity(id);
    const skill = await activeSkillFor(PURPOSE);
    const settings = effectiveSettings(skill);
    const bills = await Document.findAll({
        where: { opportunityId: opportunity.id, [Op.or]: [{ category: "bill" }, { type: "energy_bill" }] },
        attributes: ["id", "name", "mime", "createdAt", "storageUrl", "url", "opportunityId", "type", "category"],
        order: [["createdAt", "DESC"]],
    });
    return {
        skill: skill ? { id: skill.id, name: skill.name, version: skill.version } : null,
        settings,
        aiConfigured: llmConfigured(),
        bills: bills.map((b) => ({ id: b.id, name: b.name, mime: b.mime, createdAt: b.createdAt, readable: LLM_FILE_TYPES.includes(b.mime || MIME_BY_EXTENSION[extensionOf(b.name)] || "") })),
        jobInput: inputFromJob(opportunity, settings),
    };
};

/** Works out the figures for an input without saving anything — the editor's live preview. */
export const previewCalculation = async (id, payload = {}) => {
    await loadOpportunity(id);
    const skill = await activeSkillFor(PURPOSE);
    const settings = effectiveSettings(skill);
    const input = cleanInput(payload.input ?? {}, settings);
    return { input, result: calculateProposal(calculatorInput(input), settings) };
};

// ---- Writes -----------------------------------------------------------------------------

const saveNew = async (opportunity, { input, narrative = {}, ai = null, skill, settings, actor, ctx, title = null }) => {
    const unit = await BusinessUnit.findByPk(opportunity.businessUnitId);
    const result = calculateProposal(calculatorInput(input), settings);
    const preparedOn = unitDate(unit);
    const row = await sequelize.transaction(async (transaction) =>
        EnergyProposal.create(
            {
                opportunityId: opportunity.id,
                businessUnitId: opportunity.businessUnitId,
                number: await nextNumber(unit, settings, transaction),
                revision: 1,
                title: title || titleFor(result),
                status: "draft",
                preparedOn,
                validUntil: addDays(preparedOn, settings.quote.validityDays ?? 30),
                skillId: skill?.id ?? null,
                skillVersion: skill?.version ?? null,
                input,
                result,
                narrative,
                ai,
                createdById: actor?.id ?? null,
                updatedById: actor?.id ?? null,
            },
            { transaction }
        )
    );
    await recordSystemEvent(opportunity, `Energy proposal ${row.number} started — ${row.title}${ai ? " (drafted with AI)" : ""}.`, actor);
    await recordActivity({ actor, ctx, businessUnitId: row.businessUnitId, entityType: "energy_proposal", entityId: row.id, entityLabel: row.number, action: ai ? "drafted_with_ai" : "created", meta: { opportunity: opportunity.number, skillVersion: row.skillVersion } });
    return EnergyProposal.findByPk(row.id, { include: INCLUDE });
};

/** A blank draft from what the job knows: { title? }. */
export const createProposal = async (id, payload = {}, actor, ctx) => {
    const opportunity = await loadOpportunity(id);
    const skill = await activeSkillFor(PURPOSE);
    const settings = effectiveSettings(skill);
    const input = payload.input ? cleanInput(payload.input, settings) : inputFromJob(opportunity, settings);
    const row = await saveNew(opportunity, { input, skill, settings, actor, ctx, title: oneLine(payload.title, 200) || null });
    return presentFull(row, opportunity);
};

/** The bills to send the AI: the ones chosen, else the newest readable bills on the job. */
const billFiles = async (opportunity, documentIds) => {
    const where = { opportunityId: opportunity.id };
    if (Array.isArray(documentIds) && documentIds.length) where.id = documentIds.map((d) => parseId(d, "documentIds entry"));
    else where[Op.or] = [{ category: "bill" }, { type: "energy_bill" }];
    const docs = await Document.findAll({ where, order: [["createdAt", "DESC"]], limit: MAX_BILLS * 2 });
    if (Array.isArray(documentIds) && docs.length !== documentIds.length) throw httpError(404, "One of those documents is not on this job");
    const files = [];
    let bytes = 0;
    const used = [];
    for (const doc of docs) {
        const mime = doc.mime || MIME_BY_EXTENSION[extensionOf(doc.name)] || "";
        if (!LLM_FILE_TYPES.includes(mime) || !doc.url) continue;
        if (files.length >= MAX_BILLS) break;
        const { body, size } = await storage.open(doc.url);
        if (bytes + Number(size || 0) > MAX_BILL_BYTES) break;
        const data = Buffer.from(await body.transformToByteArray());
        bytes += data.length;
        files.push(billFile(mime, data));
        used.push({ id: doc.id, name: doc.name });
    }
    return { files, used };
};

/** The default words the AI starts from — with the exclusions, which it may reword for the site. */
const draftWords = ({ input, result, settings }) => ({ ...defaultNarrative({ input, result, settings }), exclusions: fixedText({ input, result, settings }).exclusions });

const withNarrative = async ({ skill, input, result, settings, instructions }) => {
    try {
        const draft = draftWords({ input, result, settings });
        const { narrative } = await writeNarrative({ skill, figures: narrativeFigures(input, result, draft), instructions });
        return narrative;
    } catch (err) {
        // The figures are what matter; the default words stand if the AI cannot write them now.
        logger.warn(`Proposal narrative not written by AI: ${err.message}`);
        return null;
    }
};

/**
 * { instructions?, documentIds?, proposalId? } → the proposal. The AI reads
 * the bills and fills in the input to the skill; the calculator works out the
 * figures; the AI then writes the words. With proposalId the draft given is
 * redone in place (its own edits are replaced); otherwise a new draft is made.
 */
export const draftWithAi = async (id, payload = {}, actor, ctx) => {
    const opportunity = await loadOpportunity(id);
    const skill = await activeSkillFor(PURPOSE);
    if (!skill) throw httpError(409, "No active proposal skill — add one on Admin → AI skills");
    const settings = effectiveSettings(skill);
    const existing = payload.proposalId ? await loadProposal(opportunity, payload.proposalId) : null;
    if (existing?.status === "final") throw httpError(409, "This proposal is final — make a new revision to change it");
    const instructions = multiLine(payload.instructions, 3000) || null;
    const { files, used } = await billFiles(opportunity, payload.documentIds);
    if (!files.length && !instructions && !existing)
        throw httpError(400, "Add the customer's electricity bill to the job (or choose one), or say in the instructions what to quote");

    const drafted = await draftInput({
        skill,
        settings,
        job: jobBrief(opportunity),
        instructions,
        current: existing ? existing.input : null,
        files,
    });
    // What the job knows fills any gap the AI left (client name, ABN, address).
    const fromJob = inputFromJob(opportunity, settings);
    const raw = drafted.input ?? {};
    const input = cleanInput(
        {
            ...raw,
            client: { name: raw.client?.name || fromJob.client.name, abn: raw.client?.abn || fromJob.client.abn },
            site: { ...fromJob.site, ...Object.fromEntries(Object.entries(raw.site ?? {}).filter(([, v]) => v !== null && v !== "")) },
        },
        settings
    );
    const result = calculateProposal(calculatorInput(input), settings);
    const narrative = (await withNarrative({ skill, input, result, settings, instructions })) ?? {};
    const ai = { model: drafted.model, instructions, documents: used, openItems: drafted.openItems, workingNotes: drafted.workingNotes, at: new Date().toISOString(), skillVersion: skill.version };

    if (existing) {
        await existing.update({ input, result, narrative, ai, skillId: skill.id, skillVersion: skill.version, title: titleFor(result), updatedById: actor?.id ?? null });
        await recordActivity({ actor, ctx, businessUnitId: existing.businessUnitId, entityType: "energy_proposal", entityId: existing.id, entityLabel: existing.number, action: "redrafted_with_ai", meta: { documents: used.map((d) => d.name) } });
        return presentFull(await loadProposal(opportunity, existing.id), opportunity);
    }
    const row = await saveNew(opportunity, { input, narrative, ai, skill, settings, actor, ctx });
    return presentFull(row, opportunity);
};

const assertDraft = (row) => {
    if (row.status === "final") throw httpError(409, `${row.number} is final — make a new revision to change it`);
};

/**
 * { input?, narrative?, title?, number?, preparedOn?, validUntil? } — every
 * save recalculates the figures. Narrative fields set to "" go back to the
 * default wording.
 */
export const updateProposal = async (id, proposalId, payload = {}, actor, ctx) => {
    const opportunity = await loadOpportunity(id);
    const row = await loadProposal(opportunity, proposalId);
    assertDraft(row);
    const skill = await skillFor(row);
    const settings = effectiveSettings(skill);
    const changes = {};
    if (payload.input !== undefined) changes.input = cleanInput(payload.input, settings);
    if (payload.narrative !== undefined) {
        if (payload.narrative === null) changes.narrative = {};
        else {
            const next = { ...(row.narrative ?? {}) };
            for (const key of EDITABLE_NARRATIVE) {
                if (payload.narrative[key] === undefined) continue;
                const value = payload.narrative[key];
                if (Array.isArray(value)) {
                    if (!LIST_NARRATIVE.includes(key)) throw httpError(400, `narrative.${key} must be text`);
                    next[key] = value
                        .slice(0, key === "exclusions" ? 8 : 6)
                        .map((x) => ({ title: oneLine(x?.title, 80), body: multiLine(x?.body, 400) }))
                        .filter((x) => x.title || x.body);
                    if (!next[key].length) delete next[key];
                } else if (value === null || value === "") delete next[key];
                else next[key] = multiLine(value, 800);
            }
            changes.narrative = next;
        }
    }
    if (payload.title !== undefined) changes.title = oneLine(payload.title, 200) || row.title;
    if (payload.number !== undefined) {
        const number = oneLine(payload.number, 40);
        if (!number) throw httpError(400, "The quote number cannot be empty");
        changes.number = number;
    }
    for (const key of ["preparedOn", "validUntil"]) {
        if (payload[key] === undefined) continue;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(payload[key]))) throw httpError(400, `${key} must be a date (YYYY-MM-DD)`);
        changes[key] = payload[key];
    }
    if (!Object.keys(changes).length) throw httpError(400, "No changes provided");
    const input = changes.input ?? row.input;
    changes.result = calculateProposal(calculatorInput(input), settings);
    await row.update({ ...changes, updatedById: actor?.id ?? null });
    await recordActivity({ actor, ctx, businessUnitId: row.businessUnitId, entityType: "energy_proposal", entityId: row.id, entityLabel: row.number, action: "updated", meta: { fields: Object.keys(changes).filter((k) => k !== "result"), netIncGst: changes.result.net.incGst } });
    return presentFull(await loadProposal(opportunity, row.id), opportunity);
};

/** { instructions? } — the AI rewrites the words from the current figures, to the skill. */
export const rewriteNarrative = async (id, proposalId, payload = {}, actor, ctx) => {
    const opportunity = await loadOpportunity(id);
    const row = await loadProposal(opportunity, proposalId);
    assertDraft(row);
    const skill = await skillFor(row);
    if (!skill) throw httpError(409, "No active proposal skill — add one on Admin → AI skills");
    const settings = effectiveSettings(skill);
    const result = calculateProposal(calculatorInput(row.input ?? {}), settings);
    const draft = draftWords({ input: row.input ?? {}, result, settings });
    const { narrative, model } = await writeNarrative({ skill, figures: narrativeFigures(row.input ?? {}, result, draft), instructions: multiLine(payload.instructions, 2000) || null });
    await row.update({ narrative: { ...(row.narrative ?? {}), ...narrative }, result, ai: { ...(row.ai ?? {}), narrativeModel: model, narrativeAt: new Date().toISOString() }, updatedById: actor?.id ?? null });
    await recordActivity({ actor, ctx, businessUnitId: row.businessUnitId, entityType: "energy_proposal", entityId: row.id, entityLabel: row.number, action: "narrative_rewritten" });
    return presentFull(await loadProposal(opportunity, row.id), opportunity);
};

/**
 * What the customer's PDF is drawn from, frozen in the quote version: the
 * proposal as the PDF needs it, and nothing internal (no open items, AI notes,
 * skill or people beyond "prepared by").
 */
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * The proposal as quote lines — what the rest of the pipeline reads from an
 * accepted version (the procurement BOQ, the approvals' system summary, the
 * installation record, the export): items priced incl. GST (tax treatment
 * "inclusive", as the proposal prices them) and the incentives as rebates, so
 * the lines add up to the net price. The PDF is never drawn from these.
 */
const quoteLinesOf = (p) => {
    const input = p.input ?? {};
    const result = p.result ?? {};
    const sys = input.system ?? {};
    const lines = new Map((result.prices?.lines ?? []).map((l) => [l.key, l]));
    const items = [];
    const add = (itemKey, itemName, brand, quantity, total) => {
        const qty = quantity > 0 ? quantity : 1;
        items.push({ itemKey, itemName, brand: brand || null, unit: "ea", quantity: qty, unitPrice: r2(total / qty), discountPct: 0 });
    };
    if (sys.battery && lines.get("battery")) add("battery", `${result.system?.nominalKwh ?? sys.battery.nominalKwh} kWh battery storage system`, sys.battery.name, sys.battery.quantity || 1, lines.get("battery").incGst);
    if (sys.solar && lines.get("solar")) add("solar_panel", sys.solar.specLabel || sys.solar.name, sys.solar.name, result.system?.panelCount || 0, lines.get("solar").incGst);
    if (sys.inverter) {
        const key = /hybrid/i.test(`${sys.inverter.type ?? ""} ${sys.inverter.name ?? ""}`) ? "hybrid_inverter" : "string_inverter";
        add(key, sys.inverter.specLabel || sys.inverter.name, sys.inverter.name, sys.inverter.quantity || 1, lines.get("inverter")?.incGst ?? 0);
    }
    if (sys.ev && !sys.ev.future && lines.get("ev")) add("ev_charger", sys.ev.name, sys.ev.name, sys.ev.chargers, lines.get("ev").incGst);
    for (const [key, line] of lines) if (key.startsWith("extra_")) add(key, line.label, null, 1, line.incGst);

    const inc = result.incentives ?? {};
    const rebate = (costType, value) => (value > 0 ? [{ kind: "rebate", costType, calcType: "fixed", value: r2(value), description: "" }] : []);
    const kinds = [result.system?.solarKw ? "Solar" : null, result.system?.nominalKwh ? "Battery" : null].filter(Boolean);
    return {
        quoteNumber: p.number,
        customer: input.client?.name ?? "",
        project: p.title ?? "",
        projectType: kinds.length === 2 ? "Solar + Battery" : kinds[0] ?? "Other",
        quoteDate: p.preparedOn ?? null,
        taxTreatment: "inclusive",
        gstRatePct: 10,
        items,
        additionalCosts: [
            ...rebate(`PRCs (NSW PDRS${inc.prc?.category ? ` ${inc.prc.category}` : ""})`, inc.prc?.value),
            ...rebate("STCs (battery)", inc.batteryStc?.value),
            ...rebate("STCs (solar)", inc.solarStc?.value),
        ],
    };
};

const versionSnapshot = (p) => {
    const result = { ...(p.result ?? {}) };
    delete result.flags;
    return {
        kind: "energy_proposal",
        opportunityNumber: p.document?.jobNumber ?? null,
        grandTotal: p.result?.net?.incGst ?? null,
        site: p.input?.site?.address ?? "",
        quote: quoteLinesOf(p),
        energyProposal: {
            id: p.id,
            number: p.number,
            revision: p.revision,
            title: p.title,
            status: "final",
            preparedOn: p.preparedOn,
            validUntil: p.validUntil,
            input: p.input,
            result,
            text: p.text,
            document: p.document,
        },
    };
};

/** The job's quote — a version always belongs to one, so a job quoted only by proposal gets an (empty) one. */
const quoteForVersions = async (opportunity, actor, transaction) => {
    const existing = await Quote.findOne({ where: { opportunityId: opportunity.id }, order: [["id", "ASC"]], transaction, lock: transaction.LOCK.UPDATE });
    if (existing) return existing;
    const unit = await BusinessUnit.findByPk(opportunity.businessUnitId, { attributes: ["id", "timezone"], transaction });
    return Quote.create(
        { opportunityId: opportunity.id, quoteNumber: opportunity.number.replace(/^([A-Z0-9]+)-/, "$1-Q-"), quoteDate: unitDate(unit), createdById: actor?.id ?? null },
        { transaction }
    );
};

/**
 * Locks the proposal — its figures and words are what is sent — and saves it
 * as the next version of the job's quote, which is what the proposal stage
 * sends the customer (and what they accept).
 */
export const finaliseProposal = async (id, proposalId, actor, ctx) => {
    const opportunity = await loadOpportunity(id);
    const row = await loadProposal(opportunity, proposalId);
    assertDraft(row);
    const skill = await skillFor(row);
    const settings = effectiveSettings(skill);
    const result = calculateProposal(calculatorInput(row.input ?? {}), settings);
    if (!result.prices.lines.length) throw httpError(400, "Price a system before marking the proposal final");
    const unit = await BusinessUnit.findByPk(row.businessUnitId);

    const version = await sequelize.transaction(async (transaction) => {
        // Locked first, so two people finalising at once cannot both pass assertDraft.
        const fresh = await EnergyProposal.findByPk(row.id, { transaction, lock: transaction.LOCK.UPDATE });
        assertDraft(fresh);
        await fresh.update({ status: "final", result, finalisedAt: new Date(), finalisedById: actor?.id ?? null, updatedById: actor?.id ?? null }, { transaction });
        const presented = present(fresh, { opportunity, unit, skill, settings });
        const quote = await quoteForVersions(opportunity, actor, transaction);
        const highest = await QuoteVersion.max("version", { where: { quoteId: quote.id }, transaction });
        const created = await QuoteVersion.create(
            {
                quoteId: quote.id,
                opportunityId: opportunity.id,
                version: (Number.isFinite(highest) ? highest : 0) + 1,
                quoteNumber: row.number,
                grandTotal: result.net.incGst,
                snapshot: versionSnapshot(presented),
                createdById: actor?.id ?? null,
                energyProposalId: row.id,
            },
            { transaction }
        );
        await fresh.update({ quoteVersionId: created.id }, { transaction });
        return created;
    });

    // The job is worth what it was last priced at (the net price ex GST), as for a generated quote.
    const estimate = exGstTotalOf(version);
    if (estimate !== null) await Opportunity.update({ estimatedValue: estimate }, { where: { id: opportunity.id } });
    const net = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(result.net.incGst);
    await recordSystemEvent(
        opportunity,
        `Energy proposal ${row.number}${row.revision > 1 ? ` rev ${row.revision}` : ""} marked final — net ${net} incl. GST — and saved as quote version ${version.version}, ready to send to the customer.`,
        actor
    );
    await recordActivity({ actor, ctx, businessUnitId: row.businessUnitId, entityType: "energy_proposal", entityId: row.id, entityLabel: row.number, action: "finalised", meta: { netIncGst: result.net.incGst, annualBenefit: result.savings.annualBenefit, quoteVersion: version.version } });
    return presentFull(await loadProposal(opportunity, row.id), opportunity);
};

/** A new draft revision of a proposal — same number, revision + 1, the same input and words. */
export const reviseProposal = async (id, proposalId, actor, ctx) => {
    const opportunity = await loadOpportunity(id);
    const source = await loadProposal(opportunity, proposalId);
    const skill = await activeSkillFor(PURPOSE);
    const settings = effectiveSettings(skill);
    const unit = await BusinessUnit.findByPk(opportunity.businessUnitId);
    const highest = await EnergyProposal.max("revision", { where: { opportunityId: opportunity.id, number: source.number } });
    const preparedOn = unitDate(unit);
    const row = await EnergyProposal.create({
        opportunityId: opportunity.id,
        businessUnitId: opportunity.businessUnitId,
        number: source.number,
        revision: (Number(highest) || source.revision) + 1,
        title: source.title,
        status: "draft",
        preparedOn,
        validUntil: addDays(preparedOn, settings.quote.validityDays ?? 30),
        skillId: skill?.id ?? source.skillId,
        skillVersion: skill?.version ?? source.skillVersion,
        input: source.input,
        result: calculateProposal(calculatorInput(source.input ?? {}), settings),
        narrative: source.narrative,
        ai: source.ai,
        createdById: actor?.id ?? null,
        updatedById: actor?.id ?? null,
    });
    await recordActivity({ actor, ctx, businessUnitId: row.businessUnitId, entityType: "energy_proposal", entityId: row.id, entityLabel: row.number, action: "revised", meta: { fromRevision: source.revision, revision: row.revision } });
    return presentFull(await loadProposal(opportunity, row.id), opportunity);
};

export const deleteProposal = async (id, proposalId, actor, ctx) => {
    const opportunity = await loadOpportunity(id);
    const row = await loadProposal(opportunity, proposalId);
    assertDraft(row);
    await row.destroy();
    await recordActivity({ actor, ctx, businessUnitId: row.businessUnitId, entityType: "energy_proposal", entityId: row.id, entityLabel: row.number, action: "deleted" });
};

/**
 * The PDF built in the browser, filed on the job's documents (type proposal)
 * and linked to the proposal. A newer PDF of the same proposal replaces the link.
 */
export const attachPdf = async (id, proposalId, file, actor, ctx) => {
    const opportunity = await loadOpportunity(id);
    const row = await loadProposal(opportunity, proposalId);
    if (!file) throw httpError(400, 'Attach the PDF in the "file" field');
    if (extensionOf(file.originalname) !== "pdf") throw httpError(400, "Only the proposal PDF can be saved here");
    const [doc] = await addDocuments(opportunity.id, [file], { type: "proposal", stage: opportunity.stage, label: `energy_proposal_${row.id}` }, actor);
    await row.update({ documentId: doc.id });
    await recordSystemEvent(opportunity, `Energy proposal ${row.number}${row.revision > 1 ? ` rev ${row.revision}` : ""} PDF saved to the job's documents (${file.originalname}).`, actor);
    await recordActivity({ actor, ctx, businessUnitId: row.businessUnitId, entityType: "energy_proposal", entityId: row.id, entityLabel: row.number, action: "pdf_saved", meta: { documentId: doc.id } });
    return presentFull(await loadProposal(opportunity, row.id), opportunity);
};
