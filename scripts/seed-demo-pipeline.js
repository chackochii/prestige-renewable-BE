// Demo jobs for the pipeline pages: 20 leads (stage 1), 20 in estimation (2),
// 20 in approvals (5) and 20 in procurement & delivery (6) by default, each
// spread across the states its stage goes through, so the paged lists, the
// stat cards and the checklists have something real-looking to show.
//
//   npm run demo:seed                    add them to unit PRS
//   npm run demo:seed -- --count=10      10 at each stage instead
//   npm run demo:seed -- --unit=PCC      in another business unit
//   npm run demo:seed -- --fresh         take out the earlier demo jobs first
//   npm run demo:remove                  take out every demo job and all that hangs off it
//
// Every demo job carries one history note (DEMO_NOTE); that is how
// demo:remove finds them, so it never touches a real job. Customers have
// @demo.example.com addresses. Leads are created through createLead (real
// numbers, real checklist rules); later stages are written straight to the
// tables, backdated, with no notifications sent. Dates are relative to the
// day it runs, so "overdue" and "entered 3 days ago" stay true to the data.

import "dotenv/config";
import crypto from "node:crypto";
import { QueryTypes } from "sequelize";
import db from "../models/index.js";
import { createLead } from "../modules/opportunity/service/opportunityService.js";
import { getProcurementJob, requiredApprovers, variationPct } from "../modules/opportunity/service/procurementService.js";

const { sequelize, BusinessUnit, CatalogItem, Opportunity, OpportunityHistory, Quote, QuoteItem, QuoteCost, QuoteVersion, Proposal, Approval, ProcurementJob, PurchaseOrder, User } = db;

export const DEMO_NOTE = "Demo data — added by scripts/seed-demo-pipeline.js; `npm run demo:remove` takes every demo job out again.";
const DEMO_DOMAIN = "demo.example.com";
const DAY = 86400000;
const NOW = new Date();

// ---- Options ----------------------------------------------------------------------

const args = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
        const [key, value] = arg.replace(/^--/, "").split("=");
        return [key, value ?? true];
    })
);
const REMOVE = Boolean(args.remove);
const FRESH = Boolean(args.fresh);
const COUNT = Math.max(1, Math.min(100, Number(args.count) || 20));
const UNIT_CODE = String(args.unit || "PRS").toUpperCase();

// ---- Repeatable randomness (same data every run) --------------------------------------

let seed = 20261004;
const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1));
const pick = (list) => list[Math.floor(random() * list.length)];
const chance = (p) => random() < p;

// ---- Dates ------------------------------------------------------------------------------

/** `days` ago at a working hour; never later than now. */
const ago = (days, hour = int(8, 17), minute = int(0, 59)) => {
    const date = new Date(NOW.getTime() - days * DAY);
    date.setHours(hour, minute, 0, 0);
    return date > NOW ? new Date(NOW.getTime() - int(10, 120) * 60000) : date;
};
/** `days` from now — delivery slots, quote validity. */
const ahead = (days, hour = 9) => {
    const date = new Date(NOW.getTime() + days * DAY);
    date.setHours(hour, 0, 0, 0);
    return date;
};
const day = (date) => date.toISOString().slice(0, 10);
const plusDays = (date, days) => new Date(date.getTime() + days * DAY);
/** Something that already happened can't be later than now. */
const past = (date) => (date > NOW ? new Date(NOW.getTime() - 60000) : date);
const money = (value) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(Number(value) || 0);
const cents = (value) => Math.round(value * 100) / 100;
/** Spread n items from lo to hi days ago, newest (i = 0) first, with a little jitter. */
const spread = (i, n, lo, hi) => Math.max(lo, Math.min(hi, Math.round(lo + ((hi - lo) * i) / Math.max(1, n - 1)) + int(-1, 1)));

// ---- People and places ------------------------------------------------------------------

const FIRST = ["Olivia", "Liam", "Charlotte", "Noah", "Amelia", "Jack", "Isla", "William", "Mia", "Oliver", "Ava", "Henry", "Grace", "Lucas", "Chloe", "Thomas", "Zoe", "James", "Ruby", "Ethan", "Harper", "Leo", "Sienna", "Samuel", "Ella", "Daniel", "Matilda", "Ryan", "Aisha", "Arjun", "Priya", "Wei", "Mei", "Hamish", "Lachlan", "Sophie", "Nikhil", "Fatima", "Marco", "Elena"];
const LAST = ["Nguyen", "Smith", "Patel", "Williams", "Brown", "Wilson", "Taylor", "Chen", "Singh", "Martin", "Anderson", "Thompson", "White", "Kelly", "Walker", "Harris", "Ryan", "Lee", "King", "Wright", "Murphy", "O'Brien", "Campbell", "Robinson", "Scott", "Kumar", "Green", "Baker", "Mitchell", "Rossi", "Papadopoulos", "Hughes", "Russo", "Kaur", "Fraser", "Morgan", "Edwards", "Clarke", "Bennett", "Doyle"];
// [suburb, postcode, council, distribution network]
const SUBURBS = [
    ["Parramatta", "2150", "City of Parramatta", "Endeavour Energy"], ["Castle Hill", "2154", "The Hills Shire Council", "Endeavour Energy"],
    ["Baulkham Hills", "2153", "The Hills Shire Council", "Endeavour Energy"], ["Kellyville", "2155", "The Hills Shire Council", "Endeavour Energy"],
    ["Rouse Hill", "2155", "The Hills Shire Council", "Endeavour Energy"], ["Blacktown", "2148", "Blacktown City Council", "Endeavour Energy"],
    ["Penrith", "2750", "Penrith City Council", "Endeavour Energy"], ["Liverpool", "2170", "Liverpool City Council", "Endeavour Energy"],
    ["Campbelltown", "2560", "Campbelltown City Council", "Endeavour Energy"], ["Hornsby", "2077", "Hornsby Shire Council", "Ausgrid"],
    ["Chatswood", "2067", "Willoughby City Council", "Ausgrid"], ["Ryde", "2112", "City of Ryde", "Ausgrid"],
    ["Epping", "2121", "City of Parramatta", "Ausgrid"], ["Cherrybrook", "2126", "Hornsby Shire Council", "Ausgrid"],
    ["Dural", "2158", "Hornsby Shire Council", "Endeavour Energy"], ["Northmead", "2152", "City of Parramatta", "Endeavour Energy"],
    ["Seven Hills", "2147", "Blacktown City Council", "Endeavour Energy"], ["Quakers Hill", "2763", "Blacktown City Council", "Endeavour Energy"],
    ["Marsden Park", "2765", "Blacktown City Council", "Endeavour Energy"], ["Oran Park", "2570", "Camden Council", "Endeavour Energy"],
    ["Gregory Hills", "2557", "Camden Council", "Endeavour Energy"], ["Leppington", "2179", "Camden Council", "Endeavour Energy"],
    ["Cronulla", "2230", "Sutherland Shire Council", "Ausgrid"], ["Sutherland", "2232", "Sutherland Shire Council", "Ausgrid"],
    ["Miranda", "2228", "Sutherland Shire Council", "Ausgrid"], ["Engadine", "2233", "Sutherland Shire Council", "Ausgrid"],
    ["Hurstville", "2220", "Georges River Council", "Ausgrid"], ["Kogarah", "2217", "Georges River Council", "Ausgrid"],
    ["Bankstown", "2200", "City of Canterbury-Bankstown", "Ausgrid"], ["Strathfield", "2135", "Strathfield Council", "Ausgrid"],
    ["Burwood", "2134", "Burwood Council", "Ausgrid"], ["Concord", "2137", "City of Canada Bay", "Ausgrid"],
    ["Manly", "2095", "Northern Beaches Council", "Ausgrid"], ["Dee Why", "2099", "Northern Beaches Council", "Ausgrid"],
    ["Mona Vale", "2103", "Northern Beaches Council", "Ausgrid"], ["Frenchs Forest", "2086", "Northern Beaches Council", "Ausgrid"],
    ["Wahroonga", "2076", "Ku-ring-gai Council", "Ausgrid"], ["Turramurra", "2074", "Ku-ring-gai Council", "Ausgrid"],
    ["Pennant Hills", "2120", "Hornsby Shire Council", "Ausgrid"], ["Carlingford", "2118", "City of Parramatta", "Ausgrid"],
    ["Windsor", "2756", "Hawkesbury City Council", "Endeavour Energy"], ["Richmond", "2753", "Hawkesbury City Council", "Endeavour Energy"],
];
const STREETS = ["Wattle Street", "Banksia Avenue", "Kurrajong Road", "Jacaranda Drive", "Waratah Crescent", "Bottlebrush Place", "Ironbark Close", "Grevillea Way", "Lilly Pilly Lane", "Acacia Road", "Blackbutt Avenue", "Myrtle Street", "Tallowwood Drive", "Boronia Parade", "Coolabah Court", "Melaleuca Grove", "Spotted Gum Close", "Paperbark Avenue", "Angophora Street", "Flame Tree Place"];
const BUSINESSES = ["Joinery", "Physiotherapy", "Motors", "Bakery", "Dental", "Engineering", "Cabinetry", "Vet Clinic"];
const SOURCES = [
    ["inbound", "Website enquiry form"],
    ["inbound", "Google search — solar and battery quotes"],
    ["inbound", "Facebook ad — spring battery offer"],
    ["internal", "Referred by a neighbour who installed with us last year"],
    ["internal", "Home show stand — Rouse Hill"],
    ["inbound", "Called the office after a letterbox drop"],
    ["internal", "Repeat customer — adding to their system"],
];
const COMMENTS = {
    solar: [
        "Quarterly bills over $800 — wants to cut daytime use with solar; home most days.",
        "New build, nothing on the roof yet. Wants a system sized for a pool pump and ducted air.",
        "Old 1.5 kW system died; wants a modern replacement sized for the whole house.",
    ],
    battery: [
        "Already has 6.6 kW of solar exporting most of the day; wants a battery to use it at night.",
        "Frequent outages on the street — wants backup for the fridge, lights and internet.",
    ],
    both: [
        "Working from home and planning an EV — wants solar plus a battery for the evenings.",
        "Bills keep climbing; wants to get as close to off-grid as the budget allows.",
        "Retired couple, home all day — interested in solar and a battery, paying with finance.",
    ],
};
const NEXT_ACTIONS = ["Call to book the site visit", "Send the battery comparison sheet", "Follow up for the last two electricity bills", "Confirm the roof type from photos"];
const NOT_POTENTIAL = ["Renting — the landlord will not consent to the installation.", "Roof is heavily shaded by neighbouring trees and the customer does not want a battery-only system."];

// ---- Small writers --------------------------------------------------------------------

const file = (filename) => ({ id: `demo-${crypto.randomUUID()}`, filename, url: null });

/** Set a row's timestamps after the fact (Sequelize stamps "now" on create). */
const stamp = async (model, id, createdAt, updatedAt = createdAt) => {
    await sequelize.query(`UPDATE "${model.getTableName()}" SET created_at = :createdAt, updated_at = :updatedAt WHERE id = :id`, {
        replacements: { id, createdAt: past(createdAt), updatedAt: past(updatedAt) },
    });
};

const note = async (opportunityId, text, at, authorId = null) => {
    const row = await OpportunityHistory.create({ opportunityId, authorId, kind: "system", note: text });
    await stamp(OpportunityHistory, row.id, at);
};

// ---- What gets quoted -----------------------------------------------------------------

let catalog = {};
const brandOf = (key, name) => catalog[key]?.brands.find((brand) => brand.name === name) ?? catalog[key]?.brands[0];
const item = (key, brandName, quantity, discountPct = 0) => {
    const entry = catalog[key];
    if (!entry) return null;
    const brand = brandName ? brandOf(key, brandName) : pick(entry.brands);
    return { itemKey: key, itemName: entry.name, brand: brand.name, unit: entry.unit, quantity, unitPrice: Number(brand.unitPrice), discountPct };
};
const BATTERY_KWH = { "Tesla Powerwall 3": 13.5, "Sungrow SBR HV": 12.8, "BYD Battery-Box Premium HVM": 11.04, "AlphaESS SMILE": 10.1 };

/** A sensible system for what the customer asked for, priced off the catalogue. */
const designSystem = (service) => {
    const items = [];
    const solar = service !== "battery";
    const storage = service !== "solar";
    let panels = 0;
    let watts = 0;
    if (solar) {
        panels = int(12, 30);
        const panel = item("solar_panel", null, panels);
        watts = Number((panel.brand.match(/(\d{3,4})W/) || [])[1]) || 440;
        items.push(panel);
        items.push(storage ? item("hybrid_inverter", null, 1) : item("string_inverter", null, 1));
        items.push(item("mounting", null, panels));
        items.push(item("dc_cable", null, int(30, 60)));
    } else items.push(item("hybrid_inverter", null, 1));
    let kwh = 0;
    if (storage) {
        const brand = pick(Object.keys(BATTERY_KWH).filter((name) => brandOf("battery", name)?.name === name));
        kwh = BATTERY_KWH[brand] ?? 10;
        items.push(item("battery", brand, kwh, chance(0.3) ? 5 : 0));
    }
    if (chance(0.25)) items.push(item("switchboard_upgrade", null, 1));
    if (chance(0.4)) items.push(item("monitoring", null, 1));
    if (chance(0.1)) items.push(item("ev_charger", null, 1));
    items.push(item("install_labour", "Standard installer", Math.max(6, Math.round(panels * 0.6) + (storage ? 4 : 0))));
    items.push(item("install_labour", "Licensed electrician", int(4, 8)));
    items.push(item("design_engineering", "In-house design", 1));
    const kw = cents((panels * watts) / 1000);
    const costs = [{ costType: "Transportation", calcType: "fixed", value: int(15, 35) * 10, description: "Delivery to site" }];
    if (solar) {
        const stcs = Math.floor(kw * 1.382 * 5);
        costs.push({ costType: "STC", calcType: "fixed", value: cents(stcs * 37.5), description: `${stcs} STCs at $37.50` });
    }
    if (storage) {
        const stcs = Math.floor(kwh * 8.4);
        costs.push({ costType: "Federal battery rebate", calcType: "fixed", value: cents(stcs * 37.5), description: `Cheaper Home Batteries — ${stcs} STCs` });
    }
    const list = items.filter(Boolean);
    const itemsTotal = list.reduce((sum, line) => sum + line.quantity * line.unitPrice * (1 - line.discountPct / 100), 0);
    const costsTotal = costs.reduce((sum, cost) => sum + (["STC", "Federal battery rebate"].includes(cost.costType) ? -cost.value : cost.value), 0);
    const grandTotal = cents((itemsTotal + costsTotal) * 1.1);
    const project = [solar ? `${kw} kW solar` : null, storage ? `${kwh} kWh battery` : null].filter(Boolean).join(" + ");
    const projectType = service === "solar" ? "Solar" : service === "battery" ? "Battery" : "Solar + Battery";
    return { items: list, costs, grandTotal, project, projectType, kw, kwh, panels };
};

// ---- Building one job -------------------------------------------------------------------

const usedNames = new Set();
const newCustomer = () => {
    let first;
    let last;
    do {
        first = pick(FIRST);
        last = pick(LAST);
    } while (usedNames.has(`${first} ${last}`));
    usedNames.add(`${first} ${last}`);
    const [suburb, postcode, council, network] = pick(SUBURBS);
    const commercial = chance(0.12);
    const handle = `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, "");
    return {
        first,
        last,
        email: `${handle}@${DEMO_DOMAIN}`,
        phone: `04${int(10, 99)} ${int(100, 999)} ${int(100, 999)}`,
        line1: `${int(2, 148)} ${pick(STREETS)}`,
        suburb,
        postcode,
        council,
        network,
        commercial,
        business: commercial ? `${last} ${pick(BUSINESSES)}` : null,
        abn: commercial ? `${int(10, 99)} ${int(100, 999)} ${int(100, 999)} ${int(100, 999)}` : null,
    };
};

/** The lead as sales captured it. `complete` fills every checklist row; otherwise a few are still open. */
const leadPayload = (unit, customer, { service, complete, qualification, salespersonId, createdAt, finance }) => {
    const [leadSource, leadSourceDetails] = pick(SOURCES);
    const reached = chance(0.8);
    const contactAt = day(plusDays(createdAt, int(0, 1)));
    const payload = {
        businessUnitId: unit.id,
        customerLegalName: customer.commercial ? `${customer.business} Pty Ltd` : `${customer.first} ${customer.last}`,
        customerTradingName: customer.commercial ? customer.business : null,
        customerAbn: customer.abn,
        customerFirstName: customer.first,
        customerLastName: customer.last,
        customerEmail: customer.email,
        customerPhone: customer.phone,
        siteLine1: customer.line1,
        siteSuburb: customer.suburb,
        siteState: "NSW",
        sitePostcode: customer.postcode,
        siteJurisdiction: "NSW",
        contactName: `${customer.first} ${customer.last}`,
        contactRole: customer.commercial ? pick(["Owner", "Operations manager"]) : null,
        contactEmail: customer.email,
        contactPhone: customer.phone,
        leadType: customer.commercial ? "commercial" : "residential",
        leadSource,
        leadSourceDetails,
        needsClientContact: true,
        contactAttempts: reached
            ? [{ method: "Phone call", contactedAt: contactAt, reached: true, reason: "" }]
            : [
                  { method: "Phone call", contactedAt: contactAt, reached: false, reason: "No answer — left a voicemail" },
                  { method: "Phone call", contactedAt: day(plusDays(createdAt, 2)), reached: true, reason: "" },
              ],
        serviceRequirement: service,
        propertyStoreys: customer.commercial ? "single" : pick(["single", "single", "double"]),
        roofType: pick(["tin", "tile", "colorbond"]),
        electricalPhase: customer.commercial ? "3_phase" : pick(["1_phase", "1_phase", "3_phase"]),
        energyHasBills: true,
        energyAnnualKwh: customer.commercial ? int(18, 45) * 1000 : int(55, 120) * 100,
        billingSameAsSite: "yes",
        financeAssistance: finance ? "yes" : "no",
        financeNotes: finance ? "Wants to spread the cost — interested in a Brighte green loan over 5 years." : null,
        siteRequirementsNone: chance(0.6),
        preferredInstallTimeframe: pick(["asap", "1_3_months", "1_3_months", "3_6_months"]),
        preferredInstallLocation: customer.commercial ? "Factory roof, inverter by the main switchboard" : pick(["Main roof, north and west faces", "Garage wall for the battery", "Rear roof, inverter in the garage"]),
        customerIntentConfirmed: true,
        customerComments: pick(COMMENTS[service]),
        qualification,
        salespersonId,
        nextAction: pick(NEXT_ACTIONS),
        nextActionDueAt: day(plusDays(createdAt, int(1, 4))),
    };
    if (!payload.siteRequirementsNone) payload.siteSpecificRequirements = pick(["Two-storey at the rear — scaffold needed", "Dog on site — call before arriving", "Switchboard is in the garage, access via side gate"]);
    if (!complete) {
        // A lead still being worked: a few checklist rows open.
        delete payload.roofType;
        if (chance(0.5)) delete payload.energyAnnualKwh;
        if (chance(0.5)) delete payload.preferredInstallTimeframe;
        payload.customerIntentConfirmed = chance(0.5);
    }
    if (qualification === "disqualified") payload.notPotentialReason = pick(NOT_POTENTIAL);
    return payload;
};

const ctx = {}; // unit, people, actors, catalogue labels, PO numbering

const labelOf = (key) => ctx.approvalTypes.find((type) => type.key === key)?.label ?? key;

/** The quote, its items and costs, and (when `saved`) version 1 frozen as the proposal's snapshot. */
const writeQuote = async (opportunity, customer, system, { at, saved }) => {
    const quoteNumber = opportunity.number.replace(/^([A-Z0-9]+)-/, "$1-Q-");
    const quote = await Quote.create({
        opportunityId: opportunity.id,
        quoteNumber,
        project: `${system.project} — ${customer.suburb}`,
        projectType: system.projectType,
        quoteDate: day(at),
        taxTreatment: "exclusive",
        gstRatePct: 10,
        createdById: ctx.estimator?.id ?? null,
    });
    await stamp(Quote, quote.id, at);
    const items = [];
    for (const [index, line] of system.items.entries()) {
        const row = await QuoteItem.create({ quoteId: quote.id, ...line, sortOrder: index });
        await stamp(QuoteItem, row.id, at);
        items.push({ id: row.id, ...line });
    }
    const costs = [];
    for (const [index, cost] of system.costs.entries()) {
        const row = await QuoteCost.create({ quoteId: quote.id, ...cost, sortOrder: index });
        await stamp(QuoteCost, row.id, at);
        costs.push({ id: row.id, ...cost });
    }
    if (!saved) return { quote, version: null };
    const snapshot = {
        opportunityNumber: opportunity.number,
        grandTotal: system.grandTotal,
        site: `${customer.line1}, ${customer.suburb} NSW ${customer.postcode}`,
        inclusions: "Supply and installation, system design, DNSP application, 10-year workmanship warranty",
        exclusions: "Tree trimming, scaffolding above two storeys, switchboard replacement unless listed",
        clientSpecialRequirements: "",
        quote: {
            quoteNumber,
            customer: opportunity.customerLegalName,
            estimatorName: ctx.estimator?.name ?? null,
            project: quote.project,
            projectType: system.projectType,
            projectTypeOther: "",
            quoteDate: day(at),
            taxTreatment: "exclusive",
            gstRatePct: 10,
            items,
            additionalCosts: costs,
        },
    };
    const version = await QuoteVersion.create({
        quoteId: quote.id,
        opportunityId: opportunity.id,
        version: 1,
        quoteNumber,
        grandTotal: system.grandTotal,
        snapshot,
        createdById: ctx.estimator?.id ?? null,
    });
    await stamp(QuoteVersion, version.id, at);
    return { quote, version };
};

/** Proposal P1, sent and accepted online by the customer. */
const writeAcceptedProposal = async (opportunity, customer, version, { sentAt, acceptedAt }) => {
    const subject = `Your proposal ${version.quoteNumber} from ${ctx.unit.name}`;
    const proposal = await Proposal.create({
        opportunityId: opportunity.id,
        number: `${opportunity.number}-P1`,
        version: 1,
        status: "accepted",
        quoteVersionId: version.id,
        grandTotal: version.grandTotal,
        priceEx: version.grandTotal,
        tokenHash: crypto.createHash("sha256").update(crypto.randomBytes(32)).digest("hex"),
        issuedAt: sentAt,
        expiresAt: plusDays(sentAt, 30),
        sentTo: customer.email,
        sentById: opportunity.salespersonId,
        emailSubject: subject,
        viewedAt: plusDays(sentAt, 0.2),
        viewCount: int(2, 6),
        response: "accepted",
        respondedAt: acceptedAt,
        responseName: `${customer.first} ${customer.last}`,
        responseChannel: "customer",
        acceptedAt,
    });
    await stamp(Proposal, proposal.id, sentAt, acceptedAt);
    await note(opportunity.id, `Proposal ${proposal.number} (quote ${version.quoteNumber} v1, ${money(version.grandTotal)}) prepared for ${customer.email} and opened in the sender's email.`, sentAt, opportunity.salespersonId);
    await note(opportunity.id, `Proposal ${proposal.number} accepted by ${customer.first} ${customer.last} (online).`, acceptedAt);
    return proposal;
};

// ---- Approvals (stage 5) -----------------------------------------------------------------

const DA_EXEMPTION = "Exempt development under the State Environmental Planning Policy (Transport and Infrastructure) 2021";

const dnspAnswers = (customer, system, status, dates) => {
    const answers = {
        network: customer.network,
        nmi: `${customer.network === "Ausgrid" ? "4103" : "4310"}${int(100000, 999999)}`,
        customerConfirmed: true,
        systemConfirmed: true,
    };
    if (status === "partial") return answers;
    Object.assign(answers, {
        exportConfirmed: true,
        applicationType: system.panels ? "basic_micro" : "alteration",
        exportLimitKw: system.panels ? 5 : 0,
        applicationInfoComplete: true,
        documents: { design: [file("system-design.pdf")], boq: [file("boq.pdf")], proposal: [file("signed-proposal.pdf")] },
    });
    if (status === "ready") return answers;
    const reference = `${customer.network === "Ausgrid" ? "AG-CN" : "EE-AP"}-${int(1000000, 9999999)}`;
    Object.assign(answers, { status, reference, submittedOn: day(dates.submittedAt) });
    if (status === "approved") Object.assign(answers, { decidedOn: day(dates.outcomeAt), connectionDocs: [file("connection-offer.pdf")] });
    if (status === "rejected") answers.decidedOn = day(dates.outcomeAt);
    return answers;
};

const daAnswers = (customer, status, dates, { needsDa }) => {
    const answers = {
        councilConfirmed: true,
        heritageChecked: true,
        planningChecked: true,
        constraintsChecked: true,
        solarNeedsDa: needsDa ? "yes" : "no",
        batteryNeedsDa: "no",
        exemptionChecked: true,
        exemptionDetails: needsDa ? "" : DA_EXEMPTION,
    };
    if (status === "partial") return { councilConfirmed: true, heritageChecked: true };
    if (needsDa) answers.approvalPathway = "Development application to council — heritage conservation area";
    if (status === "ready") return answers;
    if (!needsDa) return { ...answers, status: "exempt", evidence: [file("exemption-assessment.pdf")] };
    const reference = `DA/2026/${int(100, 999)}`;
    Object.assign(answers, { status, reference, submittedOn: day(dates.submittedAt) });
    if (status === "approved") Object.assign(answers, { decidedOn: day(dates.outcomeAt), evidence: [file("da-consent.pdf")] });
    if (status === "refused") answers.decidedOn = day(dates.outcomeAt);
    return answers;
};

const financeAnswers = (system, status, dates) => {
    const deposit = int(1, 4) * 1000;
    const financeAmount = Math.max(0, Math.round(system.grandTotal - deposit));
    const answers = {
        contactConfirmed: true,
        dwellingType: "house",
        occupancy: "owner_occupier",
        brighteChecked: true,
        brighteDetails: "",
        proposalConfirmed: true,
        deposit,
        financeAmount,
        termMonths: 60,
        financeOption: "brighte_hes",
        eligibilityConfirmed: true,
        repaymentTerm: `60 months, ${money(financeAmount / 130)} a fortnight`,
    };
    if (status === "partial") return { contactConfirmed: true, dwellingType: "house", occupancy: "owner_occupier" };
    if (status === "ready") return answers;
    Object.assign(answers, { status, reference: `BRT-${int(1000000, 9999999)}`, submittedOn: day(dates.submittedAt) });
    if (status === "approved") Object.assign(answers, { decidedOn: day(dates.outcomeAt), customerNotified: true, approvalDetails: `Approved ${money(financeAmount)} over 60 months, no conditions.` });
    if (status === "declined") Object.assign(answers, { decidedOn: day(dates.outcomeAt), customerNotified: true });
    return answers;
};

/**
 * One approval row: its status on the record, the checklist behind it, who it
 * is with and the history it leaves. `state` is not_started | partial | ready |
 * submitted | approved | rejected.
 */
const writeApproval = async (opportunity, customer, system, key, state, { enteredAt, submittedAt, outcomeAt, needsDa = false, reason = null }) => {
    const label = labelOf(key);
    // A DA nobody needs is "exempt": approved on the record, nothing lodged.
    const exemptDa = key === "da" && !needsDa && ["submitted", "approved"].includes(state);
    const recordStatus = exemptDa ? "approved" : { not_started: "not_started", partial: "not_started", ready: "not_started", submitted: "submitted", approved: "approved", rejected: "rejected" }[state];
    if (exemptDa && state === "submitted") outcomeAt = submittedAt;
    const dates = { submittedAt, outcomeAt };
    let checklist = {};
    let authority = null;
    let reference = null;
    if (key === "dnsp") {
        checklist = state === "not_started" ? {} : dnspAnswers(customer, system, state, dates);
        authority = customer.network;
        reference = checklist.reference ?? null;
    } else if (key === "da") {
        const daState = exemptDa ? "exempt" : { submitted: "lodged", approved: "approved", rejected: "refused" }[state] ?? state;
        checklist = state === "not_started" ? {} : daAnswers(customer, daState, dates, { needsDa });
        authority = customer.council;
        reference = checklist.reference ?? null;
    } else if (key === "finance") {
        const financeState = { rejected: "declined" }[state] ?? state;
        checklist = state === "not_started" ? {} : financeAnswers(system, financeState, dates);
        authority = "Brighte";
        reference = checklist.reference ?? null;
    } else {
        authority = { strata: `Owners corporation SP${int(10000, 99999)}`, heritage: customer.council, rebate: "NSW Peak Demand Reduction Scheme", landlord: "Landlord", electrical_safety: "NSW Fair Trading" }[key] ?? null;
        if (["submitted", "approved", "rejected"].includes(recordStatus)) reference = `${key.slice(0, 3).toUpperCase()}-${int(10000, 99999)}`;
    }
    const lodged = ["submitted", "approved", "rejected"].includes(recordStatus) && !exemptDa;
    const decided = ["approved", "rejected"].includes(recordStatus);
    const row = await Approval.create({
        opportunityId: opportunity.id,
        type: key,
        label,
        required: true,
        status: recordStatus,
        authority,
        reference,
        ownerId: recordStatus === "not_started" ? null : ctx.coordinator?.id ?? null,
        submittedAt: lodged ? submittedAt : null,
        outcomeAt: decided ? outcomeAt : null,
        notes: recordStatus === "rejected" ? reason : null,
        checklist,
    });
    await stamp(Approval, row.id, enteredAt, decided ? outcomeAt : lodged ? submittedAt : enteredAt);
    const where = [authority, reference].filter(Boolean).join(" ");
    if (lodged) await note(opportunity.id, `${label} lodged${where ? ` — ${where}` : ""}`, submittedAt, ctx.coordinator?.id);
    if (recordStatus === "approved") await note(opportunity.id, `${label} approved${where ? ` — ${where}` : ""}`, outcomeAt, ctx.coordinator?.id);
    if (recordStatus === "rejected") await note(opportunity.id, `${label} not given${where ? ` — ${where}` : ""} — ${reason}`, outcomeAt, ctx.coordinator?.id);
    return row;
};

const REJECTIONS = {
    dnsp: "Requested export of 5 kW exceeds the local transformer's hosting capacity — resubmit with export limited to 1.5 kW.",
    finance: "Lender declined — existing loan commitments over the serviceability limit. Customer to consider paying a larger deposit.",
    da: "Council refused — panels visible from the street in the heritage conservation area. Relocate the array to the rear roof.",
};

/** Which approvals a job needs: always the network; DA, finance, strata and the rest as the job calls for them. */
const approvalsFor = (customer, { finance, heritage, battery }) => {
    const keys = ["dnsp"];
    if (heritage || chance(0.35)) keys.push("da");
    if (finance) keys.push("finance");
    if (heritage) keys.push("heritage");
    if (customer.commercial || chance(0.12)) keys.push("strata");
    if (battery && chance(0.2)) keys.push("rebate");
    return keys.filter((key) => ctx.approvalTypes.some((type) => type.key === key));
};

// ---- Procurement (stage 6) ----------------------------------------------------------------

const SUPPLIER_OF = { solar_panel: "Solar Juice", string_inverter: "Solar Juice", hybrid_inverter: "Solar Juice", battery: "Solar Juice", monitoring: "Solar Juice", ev_charger: "Solar Juice", mounting: "Krannich Solar", dc_cable: "Rexel", switchboard_upgrade: "Rexel" };
const supplierFor = (line) => (line.kind === "service" ? "Sydpro install crew" : SUPPLIER_OF[line.key.replace(/_\d+$/, "")] ?? "Solar Juice");
const lineCost = (line) => (Number(line.siteQty) || 0) * (Number(line.quotedUnitCost) || 0);

/** Price every line (`share` = how many of them), moved off the proposal by `pct` percent. */
const quoteLines = (boq, pct, share = 1) =>
    boq.map((line, index) => {
        if (index >= Math.ceil(boq.length * share)) return line;
        const leadTime = line.key.startsWith("battery") && chance(0.5);
        return {
            ...line,
            supplier: supplierFor(line),
            quotedUnitCost: cents(Number(line.proposalUnitCost) * (1 + pct / 100)),
            availability: leadTime ? "lead_time" : "available",
            leadTimeDays: leadTime ? int(7, 14) : line.kind === "service" ? null : int(1, 4),
        };
    });

const supplierQuotes = (boq, receivedAt, byId) => {
    const bySupplier = new Map();
    for (const line of boq.filter((candidate) => candidate.kind === "material" && candidate.quotedUnitCost !== null))
        bySupplier.set(line.supplier, (bySupplier.get(line.supplier) ?? 0) + lineCost(line));
    const quotes = [...bySupplier.entries()].map(([supplier, total]) => ({
        supplier,
        total: cents(total),
        validUntil: day(plusDays(receivedAt, 30)),
        receivedAt: receivedAt.toISOString(),
        note: "Prices held for 30 days",
        byId,
    }));
    const main = quotes.find((quote) => quote.supplier === "Solar Juice");
    if (main) quotes.push({ supplier: "Tradezone", total: cents(main.total * 1.04), validUntil: day(plusDays(receivedAt, 14)), receivedAt: receivedAt.toISOString(), note: "Compared — dearer than Solar Juice, not used", byId });
    return quotes;
};

const BOQ_DONE = { boqMatches: true, materialsIncluded: true, quantitiesCorrect: true, siteRequirementsIncluded: true, changesApproved: true, changesApprovedDetails: "No changes — the BOQ stands as proposed" };
const quoteDone = (boq, at) => ({
    quoteCurrentConfirmed: true,
    quoteFile: [file("solar-juice-quote.pdf")],
    supplierApproved: true,
    quoteMatchesBoq: true,
    quotesCompared: true,
    comparedSuppliers: "Solar Juice, Tradezone, Krannich Solar",
    pricingConfirmed: true,
    stockConfirmed: true,
    fulfilmentMethod: "delivery",
    fulfilmentDate: day(plusDays(at, 5)),
    fulfilmentTime: "08:00",
    freightCharges: int(8, 20) * 10,
    paymentDueDate: day(plusDays(at, 30)),
    termsConfirmed: true,
    finalQuoteFile: [file("solar-juice-final-quote.pdf")],
});
const RECEIPT_DONE = { matchesPo: true, specsCorrect: true, quantitiesMatch: true, damageChecked: true, allArrived: true, discrepancyFound: "no", materialsReady: true, recordsUpdated: true, receiptFiles: [file("packing-slip.pdf")] };

/**
 * Where a job is in procurement, by `step`: matching (quotes coming in),
 * approvals (a price variation waiting on sign-off), delivery (cleared, orders
 * drafted), green_deal (orders out), done (Green Deal job created).
 */
const workProcurement = async (opportunity, { step, variant, enteredAt }) => {
    const coordinatorId = ctx.coordinator?.id ?? null;
    const coordinatorName = ctx.coordinator?.name ?? "Operations";
    const hist = (text, at) => note(opportunity.id, text, at, coordinatorId);
    // Seeds the BOQ from the accepted quote, as entering the stage does.
    await getProcurementJob(opportunity.id, ctx.coordinator);
    await sequelize.query(`UPDATE opportunity_history SET created_at = :at, updated_at = :at WHERE opportunity_id = :id AND note LIKE 'Entered Procurement%'`, { replacements: { id: opportunity.id, at: enteredAt } });
    const row = await ProcurementJob.findOne({ where: { opportunityId: opportunity.id } });
    const original = row.boq.map((line) => ({ ...line }));
    const quotedAt = past(plusDays(enteredAt, step === "matching" ? 0.5 : 1));
    const checklist = {};
    let boq = original;
    let revisions = [];
    let approvals = [];
    let greenDeal = {};

    if (step === "matching") {
        if (variant === 1) checklist.boq = { boqMatches: true, materialsIncluded: true };
        if (variant >= 2) checklist.boq = BOQ_DONE;
        if (variant === 3) {
            // The site needed more cable and two more rail kits: round 2 of the BOQ.
            const bumped = original.map((line) =>
                line.key === "dc_cable" ? { ...line, siteQty: Number(line.siteQty) + 15 } : line.key === "mounting" ? { ...line, siteQty: Number(line.siteQty) + 2 } : line
            );
            const changed = bumped.filter((line, index) => line.siteQty !== original[index].siteQty);
            if (changed.length) {
                revisions = [{ round: 1, at: plusDays(enteredAt, 0.3).toISOString(), byId: coordinatorId, by: coordinatorName, reason: "Site measure: longer cable run to the garage and two extra rail kits for the west face", lines: bumped }];
                boq = bumped.map((line) => ({ ...line, proposalQty: line.siteQty }));
                checklist.boq = { ...BOQ_DONE, changesApprovedDetails: changed.map((line) => `${line.item} ${original.find((o) => o.key === line.key).siteQty} → ${line.siteQty} ${line.unit}`).join(", ") + " — approved" };
                await hist(`BOQ revised — round 2: ${changed.map((line) => `${line.item} ${original.find((o) => o.key === line.key).siteQty} → ${line.siteQty} ${line.unit}`).join(", ")}. Site measure`, plusDays(enteredAt, 0.3));
            }
        }
        if (variant >= 2) boq = quoteLines(boq, 0, 0.5);
    } else {
        // Every line quoted; the size of the move decides who signs it off.
        const pct = step === "approvals" ? [2.4, -1.8, 6.5, 7.2][variant] : step === "delivery" && variant >= 2 ? 3.1 : variant === 1 && step !== "delivery" ? 2.2 : 0;
        boq = quoteLines(original, pct);
        checklist.boq = BOQ_DONE;
        const totals = { proposal: original.reduce((sum, line) => sum + line.proposalQty * line.proposalUnitCost, 0), quoted: boq.reduce((sum, line) => sum + lineCost(line), 0) };
        const actual = variationPct({ boq, revisions });
        const roles = requiredApprovers({ boq, revisions });
        await hist(
            roles.length
                ? `Quotes received — ${money(totals.quoted)} against ${money(totals.proposal)} proposed: variation ${actual > 0 ? "+" : ""}${actual.toFixed(1)}% (${Math.abs(actual) < 5 ? "below" : "at or above"} 5%)`
                : `Quotes received — ${money(totals.quoted)} against ${money(totals.proposal)} proposed: no price variation, purchase orders can go out`,
            quotedAt
        );
        if (roles.length) {
            const requestedAt = quotedAt.toISOString();
            const decidedAt = past(plusDays(quotedAt, 0.6));
            const signedOff = step !== "approvals";
            approvals = roles.map((role) => {
                const decided = signedOff || (step === "approvals" && variant === 3 && role === "SMM");
                const person = role === "BO" ? ctx.owner : ctx.salesManager;
                return decided
                    ? { role, approverId: person?.id ?? null, approver: person?.name ?? "Sales manager (by phone)", status: "approved", requestedAt, decidedAt: decidedAt.toISOString(), note: "Supplier price rise accepted — margin still above the floor" }
                    : { role, approverId: null, approver: null, status: "pending", requestedAt, decidedAt: null, note: null };
            });
            await hist(`Approvals requested — ${Math.abs(actual) < 5 ? "below 5%" : "5% or more"}: ${roles.map((role) => (role === "BO" ? "Business owner" : "Sales manager")).join(" and ")}`, quotedAt);
            for (const entry of approvals.filter((candidate) => candidate.status === "approved"))
                await hist(`${entry.role === "BO" ? "Business owner" : "Sales manager"} approved the price variation of ${actual > 0 ? "+" : ""}${actual.toFixed(1)}%`, decidedAt);
        }
        checklist.quote = quoteDone(boq, quotedAt);
        await hist("CL-12 supplier quote complete", plusDays(quotedAt, 0.2));
    }

    await row.update({ boq, revisions, approvals, quotes: step === "matching" && variant < 2 ? [] : supplierQuotes(boq, quotedAt, coordinatorId) });

    // Purchase orders: one per supplier of goods.
    const orders = [];
    if (["delivery", "green_deal", "done"].includes(step) && !(step === "delivery" && variant === 1)) {
        const groups = new Map();
        for (const line of boq.filter((candidate) => candidate.kind === "material")) groups.set(line.supplier, [...(groups.get(line.supplier) ?? []), line]);
        const draftedAt = past(plusDays(quotedAt, 1));
        for (const [supplier, lines] of groups) {
            const ref = `PO-${String(NOW.getFullYear()).slice(-2)}-${String(ctx.nextPo++).padStart(4, "0")}`;
            const amount = cents(lines.reduce((sum, line) => sum + lineCost(line), 0));
            const leadDays = Math.max(...lines.map((line) => line.leadTimeDays ?? 2));
            const sentAt = past(plusDays(draftedAt, 0.5));
            const fields = { opportunityId: opportunity.id, ref, supplier, lines: lines.map((line) => line.key), amount, eta: day(plusDays(sentAt, leadDays)), status: "draft", createdById: coordinatorId };
            if (step === "green_deal" || step === "done") {
                const status = step === "done" ? "delivered" : ["sent", "confirmed", "scheduled", "delivered"][variant];
                Object.assign(fields, { status, sentAt });
                if (status !== "sent") fields.confirmedAt = past(plusDays(sentAt, 0.4));
                if (["scheduled", "delivered"].includes(status)) fields.scheduledFor = day(status === "scheduled" ? ahead(int(1, 5)) : plusDays(sentAt, Math.min(leadDays, 3)));
                if (status === "delivered") Object.assign(fields, { deliveredAt: past(plusDays(sentAt, Math.min(leadDays, 3))), receivedBy: coordinatorName });
            }
            const po = await PurchaseOrder.create(fields);
            await stamp(PurchaseOrder, po.id, draftedAt, fields.deliveredAt ?? fields.sentAt ?? draftedAt);
            await hist(`Purchase order drafted — ${ref} to ${supplier}, ${money(amount)}`, draftedAt);
            if (fields.sentAt) await hist(`Purchase order sent — ${ref} to ${supplier}, ${money(amount)}`, fields.sentAt);
            if (fields.scheduledFor && fields.status === "scheduled") await hist(`Delivery scheduled — ${ref} for ${fields.scheduledFor}`, fields.confirmedAt);
            if (fields.deliveredAt) await hist(`Delivery received — ${ref} from ${supplier}, signed for by ${coordinatorName}`, fields.deliveredAt);
            orders.push(fields);
        }
    }

    // The checklists the coordinator has worked so far.
    const poTotal = cents(orders.reduce((sum, po) => sum + Number(po.amount), 0));
    const variationSigned = approvals.length > 0 && approvals.every((entry) => entry.status === "approved");
    if (step === "delivery")
        checklist.po = { basisConfirmed: true, poAmountValue: poTotal || null, poAmountMatches: orders.length > 0, variationChecked: true, ...(variationSigned ? { variationApproved: true, variationApprovedBy: "Sales manager, by phone" } : {}), supplierConfirmed: orders.length > 0 };
    if (step === "green_deal" || step === "done") {
        const releasedOn = orders[0]?.sentAt ?? quotedAt;
        checklist.po = {
            basisConfirmed: true,
            poAmountValue: poTotal,
            poAmountMatches: true,
            variationChecked: true,
            ...(variationSigned ? { variationApproved: true, variationApprovedBy: "Sales manager, by phone" } : {}),
            supplierConfirmed: true,
            deliveryConfirmed: true,
            termsConfirmed: true,
            releaseApproved: true,
            poReleasedConfirmed: true,
            poReleasedOn: day(releasedOn),
            poRecords: [file("purchase-orders.pdf")],
        };
        await hist("CL-13 purchase order release complete", releasedOn);
    }
    const allDelivered = orders.length > 0 && orders.every((po) => po.status === "delivered");
    if (allDelivered) {
        const lastDelivery = orders.reduce((latest, po) => (po.deliveredAt > latest ? po.deliveredAt : latest), orders[0].deliveredAt);
        checklist.receipt =
            step === "done" && variant === 1
                ? { ...RECEIPT_DONE, discrepancyFound: "yes", discrepancyDetails: "Two rail end clamps missing from the Krannich delivery", supplierNotified: true, replacementArranged: true }
                : RECEIPT_DONE;
        if (step === "done" && variant === 1) await hist("Delivery discrepancy recorded — Two rail end clamps missing from the Krannich delivery", lastDelivery);
        await hist("Materials confirmed ready before installation booking (CL-14)", plusDays(lastDelivery, 0.1));
        await hist("CL-14 material receipt complete", plusDays(lastDelivery, 0.1));
        if (step === "done") {
            const createdAt = past(plusDays(lastDelivery, 0.5));
            const jobId = `GD-${int(100000, 999999)}`;
            checklist.jobCreation = { greenDealJobId: jobId, greenDealCreatedOn: day(createdAt), syncConfirmed: true, matchConfirmed: true };
            greenDeal = { created: true, jobId, createdAt: createdAt.toISOString(), byId: coordinatorId, by: coordinatorName };
            await hist(`Green Deal job created — ${jobId}`, createdAt);
            await hist("CL-10 job creation complete", createdAt);
        }
    }
    await row.update({ checklist, greenDeal });
    await stamp(ProcurementJob, row.id, enteredAt, NOW);
};

// ---- The four stages -------------------------------------------------------------------------

/** Who does what in the unit: the first member holding each role. */
const loadPeople = async (unit) => {
    const members = await sequelize.query(
        `SELECT u.id, u.name, u.roles FROM users u JOIN user_business_units ub ON ub.user_id = u.id WHERE ub.business_unit_id = :unitId AND u.deleted_at IS NULL ORDER BY u.id`,
        { replacements: { unitId: unit.id }, type: QueryTypes.SELECT }
    );
    const withRole = (code) => members.filter((member) => (member.roles ?? []).includes(code));
    const admin = await User.findOne({ where: sequelize.literal(`'ADM' = ANY(roles)`), order: [["id", "ASC"]] });
    return {
        salespeople: withRole("SREP").length ? withRole("SREP") : withRole("SMM"),
        estimator: withRole("DEST")[0] ?? withRole("EST")[0] ?? null,
        coordinator: withRole("OPC")[0] ?? null,
        siteCrew: withRole("SITEOM")[0] ?? withRole("OPC")[0] ?? null,
        owner: withRole("BO")[0] ?? null,
        salesManager: withRole("SMM")[0] ?? null,
        admin: admin ? { id: admin.id, name: admin.name, roles: admin.roles } : null,
    };
};

/**
 * Plans every job first — the stage, its scenario and its dates — then
 * creates them oldest first, so the job numbers rise with the dates the way
 * they would have in real life.
 */
const plan = () => {
    const jobs = [];
    for (let i = 0; i < COUNT; i += 1) {
        // Procurement: entered 0–12 days ago; five steps, the newest arrivals earliest in the flow.
        const steps = ["matching", "approvals", "delivery", "green_deal", "done"];
        const stepIndex = Math.min(steps.length - 1, Math.floor((i * steps.length) / COUNT));
        const inStep = i - Math.ceil((stepIndex * COUNT) / steps.length);
        const enteredP = spread(i, COUNT, 0, 12) + (stepIndex >= 3 ? 1 : 0);
        const approvalsAt = enteredP + int(8, 18);
        jobs.push({ stage: 6, i, step: steps[stepIndex], variant: Math.max(0, inStep) % 4, enteredAgo: enteredP, approvalsAgo: approvalsAt, createdAgo: approvalsAt + int(14, 24) });
        // Approvals: entered 0–22 days ago.
        const enteredA = spread(i, COUNT, 0, 22);
        jobs.push({ stage: 5, i, scenario: i / COUNT, enteredAgo: enteredA, approvalsAgo: enteredA, createdAgo: enteredA + int(14, 26) });
        // Estimation: entered 0–9 days ago (SLA 5).
        const enteredE = spread(i, COUNT, 0, 9);
        jobs.push({ stage: 2, i, scenario: i / COUNT, enteredAgo: enteredE, createdAgo: enteredE + int(2, 10) });
        // Leads: created 0–12 days ago (SLA 3).
        jobs.push({ stage: 1, i, scenario: i / COUNT, createdAgo: spread(i, COUNT, 0, 12) });
    }
    for (const job of jobs) job.createdAt = ago(job.createdAgo);
    return jobs.sort((a, b) => a.createdAt - b.createdAt);
};

const buildJob = async (job) => {
    const customer = newCustomer();
    const service = pick(["solar", "both", "both", "battery", "solar", "both"]);
    const finance = job.stage >= 5 ? chance(0.35) || (job.stage === 5 && job.scenario >= 0.75 && job.i % 3 === 1) : chance(0.3);
    const createdAt = job.createdAt;
    const salesperson = job.stage === 1 && job.i % 4 === 3 ? null : pick(ctx.people.salespeople) ?? null;
    const leadQualification = job.stage > 1 ? "qualified" : job.i % 10 === 7 ? "disqualified" : job.i % 5 === 0 || job.i % 5 === 3 ? "qualified" : "nurture";
    const complete = leadQualification === "qualified" || chance(0.3);
    const actor = salesperson ? { id: salesperson.id, name: salesperson.name, roles: salesperson.roles } : ctx.people.admin;

    const created = await createLead(leadPayload(ctx.unit, customer, { service, complete, qualification: leadQualification, salespersonId: salesperson?.id ?? null, createdAt, finance }), actor);
    const opportunity = await Opportunity.findByPk(created.id);
    await note(opportunity.id, DEMO_NOTE, createdAt);
    if (salesperson) await note(opportunity.id, `Salesperson assigned: ${salesperson.name}`, plusDays(createdAt, 0.05), actor?.id);
    const system = designSystem(service);
    const fields = { estimatedValue: Math.round(system.grandTotal / 100) * 100, customerBudget: Math.round((system.grandTotal * (0.85 + random() * 0.4)) / 500) * 500 };
    let slaStartedAt = createdAt;
    let lastActivity = createdAt;

    if (job.stage >= 2) {
        const estimationAt = job.stage === 2 ? ago(job.enteredAgo) : plusDays(createdAt, int(1, 3));
        const assigned = !(job.stage === 2 && job.scenario < 0.15);
        Object.assign(fields, { estimatorId: assigned ? ctx.people.estimator?.id ?? null : null });
        if (assigned && ctx.people.estimator) await note(opportunity.id, `Estimator assigned: ${ctx.people.estimator.name}`, plusDays(estimationAt, 0.1), ctx.people.owner?.id ?? actor?.id);
        // Estimation's own steps, newest arrivals least far along: waiting for an
        // estimator, requirements to review, client info to confirm, on hold
        // for sales, a site visit out, then pricing the quote.
        const ready = job.stage > 2 || job.scenario >= 0.5;
        const onHold = job.stage === 2 && job.scenario >= 0.35 && job.scenario < 0.5;
        if (onHold)
            Object.assign(fields, { estimationRequirementsReceived: false, estimationOnHoldReason: pick(["Waiting on the last 12 months of electricity bills", "Need roof photos from the customer — the satellite image is out of date", "Customer to confirm whether the battery is for backup or bill savings"]) });
        if (ready || (job.stage === 2 && job.scenario >= 0.3 && !onHold)) {
            Object.assign(fields, {
                estimationRequirementsReceived: true,
                estimationRequirementsChecklist: ["site_address", "customer_contact", "energy_usage", "site_evidence", "budget_indication", "site_constraints"],
                estimationClientInfoNeeded: ready ? false : null,
                estimationPreSiteInspectionRequired: ready ? false : null,
                estimationChecklistValues: {
                    meter_nmi: `${customer.network === "Ausgrid" ? "4103" : "4310"} ${int(100, 999)} ${int(100, 999)}`,
                    switchboard: pick(["Garage — room for the inverter breaker", "External meter box, near capacity — upgrade quoted"]),
                    roof_type: pick(["Tile, 22° pitch, north and west faces", "Colorbond, 15° pitch, north face"]),
                    shading: pick(["Clear all day", "Light shading on the west face after 4 pm"]),
                    access: "Side gate, 1.2 m wide",
                    structural: "Trusses sound, no issues seen",
                    equipment_location: "Garage wall, out of direct sun",
                    approvals_constraints: pick(["None known", "Strata — owners corporation consent needed"]),
                },
            });
        }
        if (job.stage === 2 && job.scenario >= 0.5 && job.scenario < 0.65) {
            Object.assign(fields, { estimationPreSiteInspectionRequired: true, estimationSiteVisitAssigneeId: ctx.people.siteCrew?.id ?? null, estimationSiteVisitCompleted: job.i % 2 === 0 });
            if (ctx.people.siteCrew) await note(opportunity.id, `Site visit assigned to ${ctx.people.siteCrew.name}`, plusDays(estimationAt, 0.4), ctx.people.estimator?.id);
        }
        slaStartedAt = estimationAt;
        lastActivity = estimationAt;

        // Estimation at work: the quote is being priced, the latest ones already saved.
        if (job.stage === 2 && job.scenario >= 0.65) {
            const quotedAt = past(plusDays(estimationAt, Math.min(job.enteredAgo, 1) * 0.5 + 0.1));
            await writeQuote(opportunity, customer, system, { at: quotedAt, saved: job.scenario >= 0.85 });
            if (job.scenario >= 0.85) await note(opportunity.id, `Quote ${opportunity.number.replace(/^([A-Z0-9]+)-/, "$1-Q-")} v1 saved — ${money(system.grandTotal)}`, quotedAt, ctx.people.estimator?.id);
            lastActivity = quotedAt;
        }
    }

    if (job.stage >= 5) {
        // Quoted, proposed and accepted on the way here.
        const acceptedAt = ago(job.approvalsAgo);
        const sentAt = plusDays(acceptedAt, -int(2, 6));
        const quotedAt = plusDays(sentAt, -int(1, 3));
        const { version } = await writeQuote(opportunity, customer, system, { at: quotedAt, saved: true });
        await writeAcceptedProposal(opportunity, customer, version, { sentAt, acceptedAt });
        const heritage = job.i % 9 === 4;
        const keys = approvalsFor(customer, { finance, heritage, battery: service !== "solar" });
        // The rejected ones need the type that was refused on their list.
        const rejectedType = job.stage === 5 && job.scenario >= 0.75 && job.scenario < 0.9 ? ["dnsp", "finance", "da"][job.i % 3] : null;
        if (rejectedType && !keys.includes(rejectedType)) keys.push(rejectedType);
        const needsDa = heritage || rejectedType === "da";
        Object.assign(fields, {
            operationalCoordinatorId: ctx.coordinator?.id ?? null,
            requiredApprovals: keys,
            acceptedValue: system.grandTotal,
            financeAssistance: keys.includes("finance") ? "yes" : "no",
            financeNotes: keys.includes("finance") ? "Wants to spread the cost — interested in a Brighte green loan over 5 years." : null,
            estimationInput: { inclusions: "Supply and installation, system design, DNSP application, 10-year workmanship warranty", exclusions: "Tree trimming, scaffolding above two storeys" },
        });
        if (ctx.coordinator) await note(opportunity.id, `Operational coordinator assigned: ${ctx.coordinator.name}`, plusDays(acceptedAt, 0.05), ctx.people.owner?.id);
        await note(opportunity.id, `Approvals required: ${keys.map(labelOf).join(", ")}`, plusDays(acceptedAt, 0.02), opportunity.salespersonId);

        // Each approval's state, by where the job is.
        const state = (key, index) => {
            if (job.stage === 6) return "approved";
            const s = job.scenario;
            if (s < 0.25) return key === "dnsp" && job.i % 2 === 1 ? "partial" : "not_started";
            if (s < 0.55) return key === "dnsp" || key === "finance" || (key === "da" && !needsDa) ? "submitted" : index % 2 ? "ready" : "submitted";
            if (s < 0.75) return index === keys.length - 1 ? "submitted" : "approved";
            if (s < 0.9) return key === rejectedType ? "rejected" : key === "dnsp" ? "approved" : "submitted";
            return key === "dnsp" ? "submitted" : "not_started";
        };
        // As the record will read them (an unneeded DA is exempt, so approved).
        // A job still at approvals cannot have every one approved — the last
        // one would have moved it on — so the network approval waits.
        const states = keys.map(state);
        const reads = (key, st) => (key === "da" && !needsDa && ["submitted", "approved"].includes(st) ? "approved" : st);
        if (job.stage === 5 && keys.every((key, index) => reads(key, states[index]) === "approved")) states[0] = "submitted";
        const enteredAt = acceptedAt;
        for (const [index, key] of keys.entries()) {
            const st = states[index];
            const submittedAt = past(plusDays(enteredAt, Math.min(job.approvalsAgo, 1 + index) * 0.6 + 0.2));
            const outcomeAt = job.stage === 6 ? plusDays(ago(job.enteredAgo), -0.1 * (keys.length - index)) : plusDays(submittedAt, Math.max(0.3, Math.min(job.approvalsAgo - 1, 6 + index)));
            await writeApproval(opportunity, customer, system, key, st, { enteredAt, submittedAt, outcomeAt: outcomeAt > NOW ? NOW : outcomeAt, needsDa, reason: REJECTIONS[key] ?? "Not approved — see the authority's letter" });
        }
        slaStartedAt = enteredAt;
        lastActivity = enteredAt;
    }

    if (job.stage === 6) {
        const enteredAt = ago(job.enteredAgo);
        await note(opportunity.id, "All approvals received — on to procurement", plusDays(enteredAt, -0.01), ctx.coordinator?.id);
        slaStartedAt = enteredAt;
        await opportunity.update({ ...fields, stage: 6, slaStartedAt, slaDueAt: plusDays(slaStartedAt, Number(ctx.unit.slaDays?.[6] ?? 10)) });
        await workProcurement(opportunity, { step: job.step, variant: job.variant, enteredAt });
        lastActivity = NOW;
    } else {
        await opportunity.update({ ...fields, stage: job.stage, slaStartedAt, slaDueAt: plusDays(slaStartedAt, Number(ctx.unit.slaDays?.[job.stage] ?? 3)) });
    }
    await stamp(Opportunity, opportunity.id, createdAt, lastActivity > NOW ? NOW : lastActivity);
    return opportunity;
};

// ---- Remove ---------------------------------------------------------------------------------

const demoIds = async () =>
    (await sequelize.query(`SELECT DISTINCT opportunity_id AS id FROM opportunity_history WHERE note = :note ORDER BY opportunity_id`, { replacements: { note: DEMO_NOTE }, type: QueryTypes.SELECT })).map((row) => row.id);

const removeDemo = async () => {
    const ids = await demoIds();
    if (!ids.length) {
        console.log("No demo jobs to remove.");
        return 0;
    }
    const [{ documents }] = await sequelize.query(`SELECT COUNT(*)::int AS documents FROM documents WHERE opportunity_id IN (:ids)`, { replacements: { ids }, type: QueryTypes.SELECT });
    // Everything that hangs off a job (history, quotes, proposals, approvals,
    // procurement, orders, documents, notifications) goes with it — every
    // foreign key to opportunities cascades.
    await sequelize.query(`DELETE FROM opportunities WHERE id IN (:ids)`, { replacements: { ids } });
    console.log(`Removed ${ids.length} demo job${ids.length === 1 ? "" : "s"} and everything attached to them.`);
    if (documents) console.log(`  ${documents} uploaded document record${documents === 1 ? " was" : "s were"} removed with them; the files stay in object storage.`);
    return ids.length;
};

// ---- Main -------------------------------------------------------------------------------------

const main = async () => {
    if (REMOVE) return removeDemo();
    const existing = await demoIds();
    if (existing.length && !FRESH) {
        console.log(`There are already ${existing.length} demo jobs. Run \`npm run demo:remove\` first, or \`npm run demo:seed -- --fresh\` to replace them.`);
        process.exitCode = 1;
        return;
    }
    if (existing.length) await removeDemo();

    const unit = await BusinessUnit.findOne({ where: { code: UNIT_CODE } });
    if (!unit) throw new Error(`No business unit with code ${UNIT_CODE}`);
    ctx.unit = unit;
    ctx.approvalTypes = Array.isArray(unit.approvalTypes) ? unit.approvalTypes : [];
    ctx.people = await loadPeople(unit);
    ctx.coordinator = ctx.people.coordinator ? { id: ctx.people.coordinator.id, name: ctx.people.coordinator.name, roles: ctx.people.coordinator.roles } : ctx.people.admin;
    ctx.estimator = ctx.people.estimator;
    ctx.owner = ctx.people.owner;
    ctx.salesManager = ctx.people.salesManager;
    ctx.nextPo = (await PurchaseOrder.count()) + 1;
    catalog = Object.fromEntries((await CatalogItem.findAll({ where: { isActive: true } })).map((entry) => [entry.key, { name: entry.name, unit: entry.unit, brands: entry.brands }]));
    for (const key of ["solar_panel", "hybrid_inverter", "string_inverter", "battery", "mounting", "dc_cable", "install_labour", "design_engineering"])
        if (!catalog[key]?.brands?.length) throw new Error(`The catalogue has no "${key}" item — run \`npm run db:seed:catalog\` first`);
    if (!ctx.people.salespeople.length) console.log(`  (no salesperson in ${UNIT_CODE} — leads go unassigned)`);

    const jobs = plan();
    const made = { 1: [], 2: [], 5: [], 6: [] };
    for (const [index, job] of jobs.entries()) {
        const opportunity = await buildJob(job);
        made[job.stage].push(opportunity.number);
        if ((index + 1) % 20 === 0) console.log(`  ${index + 1} of ${jobs.length} jobs…`);
    }
    const names = { 1: "Leads", 2: "Estimation", 5: "Approvals", 6: "Procurement & delivery" };
    console.log(`\nAdded ${jobs.length} demo jobs to ${unit.name} (${unit.code}):`);
    for (const stage of [1, 2, 5, 6]) console.log(`  ${names[stage].padEnd(24)} ${String(made[stage].length).padStart(3)}`);
    console.log("\nTake them out again with: npm run demo:remove");
};

try {
    await main();
} catch (err) {
    console.error(err);
    process.exitCode = 1;
} finally {
    await sequelize.close();
}
