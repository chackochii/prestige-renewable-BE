// The words of an energy proposal. Everything the PDF prints around the
// numbers has a default written here from the calculator's result, in the
// voice of the sent Prestige proposals (the template is the Metro Petroleum
// St Marys proposal, V8) — so a proposal reads properly even with no AI. The
// AI (or the estimator) can replace the parts people tailor: the headlines,
// the subtitle, the six advantages, the six value adds, the notes on the
// energy page, the exclusions and an equipment note for the site. Conditions,
// the savings basis, the payment wording and the estimates-only notes are
// always written from the figures, so they can never disagree with them.
import { BAND_LABELS, displayKw } from "./proposalCalculator.js";

/** Narrative fields a person or the AI may set; anything else is written from the figures. */
export const EDITABLE_NARRATIVE = [
    "siteNoun",
    "headline",
    "deliveredBy",
    "whySubtitle",
    "advantages",
    "valueHeadline",
    "valueAdds",
    "sources",
    "energyNote",
    "moneyNote",
    "intro",
    "equipmentNote",
    "exclusions",
];
/** The narrative fields that are lists of { title, body }. */
export const LIST_NARRATIVE = ["advantages", "valueAdds", "exclusions"];

const money = (v, cents = true) =>
    new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 }).format(Number(v) || 0);
const whole = (v) => new Intl.NumberFormat("en-AU", { maximumFractionDigits: 0 }).format(Math.round(Number(v) || 0));
/** ~16,200 / ~190,900 / ~2,000: kWh as the proposals round them. */
const approx = (v) => {
    const n = Math.abs(Number(v) || 0);
    const step = n >= 10000 ? 100 : n >= 1000 ? 10 : 1;
    return whole(Math.round((Number(v) || 0) / step) * step);
};
/** Flows in the savings basis (~78,250 kWh): to the nearest 10. */
const tens = (v) => whole(Math.round((Number(v) || 0) / 10) * 10);
const trim = (n, places = 1) => {
    const f = 10 ** places;
    const r = Math.round((Number(n) || 0) * f) / f;
    return Number.isInteger(r) ? String(r) : r.toFixed(places).replace(/0+$/, "").replace(/\.$/, "");
};
const cents = (v) => `${trim(v, 1)}c`;
const capitalise = (s) => (s ? `${s[0].toUpperCase()}${s.slice(1)}` : s);
const joinAnd = (list) => (list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list.at(-1)}` : list[0] ?? "");

/** "Jijos Kitchen Pty Ltd" → "Jijos Kitchen"; "Metro Petroleum St Marys (Maula Buss Pty Ltd)" → "Metro Petroleum St Marys". */
export const shortClientName = (name) =>
    String(name ?? "")
        .replace(/\s*\([^)]*\)\s*$/, "")
        .replace(/\b(pty\.?\s*ltd\.?|pty\.? limited|limited|ltd\.?|trust|t\/as.*)$/i, "")
        .replace(/[,\s]+$/, "")
        .trim();

/** "WHES", "StarCharge eBOX": the battery's brand words, without its capacity or the word battery. */
export const batteryShortName = (battery) => {
    if (battery?.shortName) return battery.shortName;
    const words = String(battery?.name ?? "")
        .replace(/\d+(\.\d+)?\s*kwh/gi, "")
        .replace(/\b(battery|storage|system|energy|c&i|commercial)\b/gi, "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    return words.slice(0, 2).join(" ");
};

/** "String", "Hybrid" or "" — how the headline names a separate inverter. */
const inverterType = (inverter) => {
    if (!inverter) return "";
    if (inverter.type) return capitalise(String(inverter.type).trim());
    if (/hybrid/i.test(inverter.name ?? "")) return "Hybrid";
    if (/string/i.test(inverter.name ?? "")) return "String";
    return "";
};

/** Where the array goes, as the proposals say it: "rooftop", "rooftop / canopy". */
const mountingOf = (input) => input.system?.solar?.mounting || "rooftop";

const evState = (result) => ({
    included: result.system.evChargers > 0 && !result.system.evFuture,
    future: result.system.evChargers > 0 && result.system.evFuture === true,
});

/** "261 kWh battery + 100 kW solar" — the short system name (value-add page). */
const systemShort = (result, { newSolar = false } = {}) =>
    [result.system.nominalKwh > 0 ? `${trim(result.system.nominalKwh, 1)} kWh battery` : null, result.system.solarKw > 0 ? `${displayKw(result.system.solarKw)} kW ${newSolar ? "new " : ""}solar` : null]
        .filter(Boolean)
        .join(" + ");

/** "29 Aug–28 Sep 2026" from a bill period's dates, or its label. */
const periodText = (period) => {
    if (period?.startDate && period?.endDate) {
        const a = new Date(`${period.startDate}T00:00:00Z`);
        const b = new Date(`${period.endDate}T00:00:00Z`);
        const day = (d) => d.getUTCDate();
        const mon = (d) => ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
        if (a.getUTCFullYear() === b.getUTCFullYear()) return `${day(a)} ${mon(a)}–${day(b)} ${mon(b)} ${b.getUTCFullYear()}`;
        return `${day(a)} ${mon(a)} ${a.getUTCFullYear()}–${day(b)} ${mon(b)} ${b.getUTCFullYear()}`;
    }
    return period?.label || "";
};

const proposalKind = (result) => {
    const kinds = [];
    if (result.system.solarKw > 0) kinds.push("Solar");
    if (result.system.nominalKwh > 0) kinds.push("Battery Storage");
    if (evState(result).included) kinds.push("EV Charging");
    return kinds.join(" + ") || "Energy";
};

/** The words written from the figures — the defaults for every narrative field. */
export const defaultNarrative = ({ input = {}, result, settings }) => {
    const noun = input.narrativeHints?.siteNoun || "site";
    const tariff = input.tariff ?? {};
    const usage = result.usage;
    const cost = result.cost;
    const savings = result.savings;
    const inc = result.incentives;
    const sys = result.system;
    const ev = evState(result);
    const hasBattery = sys.nominalKwh > 0;
    const hasSolar = sys.solarKw > 0;
    const daily = savings.batteryModel !== "solar_first";
    const peakWindow = tariff.peakWindow || "4–8pm weekdays";
    const shoulderWindow = tariff.shoulderWindow || "10am–2pm";
    const peakShort = peakWindow.replace(/\s*(on\s+)?weekdays?/i, "").trim();
    const largest = cost.largest;
    const largestLabel = largest ? (largest.band === "flat" ? "usage" : BAND_LABELS[largest.band].toLowerCase()) : "usage";
    const largestPct = largest ? Math.round(usage.split[largest.band]) : 0;
    const cheapest = cost.bands.filter((b) => b.cents && b.band !== "peak").sort((a, b) => a.cents - b.cents)[0] ?? null;
    const months = result.optionA.months;
    const battery = input.system?.battery;
    const inverter = input.system?.inverter;
    const kw = displayKw(sys.solarKw);
    const retailer = input.site?.retailer;
    const topUp = hasBattery && savings.topUpKwh > 0 && savings.topUpBand;
    const evSpec = input.system?.ev ?? {};
    const evKw = trim(evSpec.kwEach || settings.savings.ev.kwEach || 22, 0);

    // ---- Headlines -------------------------------------------------------------------
    const headlineParts = [];
    if (hasBattery) headlineParts.push(`${trim(sys.nominalKwh, 1)} kWh ${batteryShortName(battery)} Battery Storage`.replace(/\s+/g, " "));
    if (hasSolar) headlineParts.push(`${kw} kW New Solar`);
    let headline = headlineParts.join(" + ") || "Energy System";
    const type = inverterType(inverter);
    if (inverter && hasSolar) headline += ` with ${sys.solarInverterKw ? `${trim(sys.solarInverterKw, 1)} kW ` : ""}${type ? `${type} ` : ""}Inverter`;
    if (ev.included) headline += ` + ${sys.evChargers} × EV Chargers`;
    if (ev.future) headline += " · EV-ready";

    const deliveredParts = [hasBattery ? `${trim(sys.nominalKwh, 1)} kWh battery` : null, hasSolar ? `${kw} kW new solar` : null, ev.included ? `${sys.evChargers} EV chargers` : null].filter(Boolean);
    const deliveredBy = `${deliveredParts.join(" + ") || "Energy system"}${ev.future ? " | EV-ready for future charging" : ""}`;
    const valueHeadline = `More value from a ${systemShort(result) || "new energy system"}${ev.future ? ", including EV charging later" : ev.included ? " and EV charging" : ""}`;

    // ---- Advantages (page 2) -------------------------------------------------------------
    const advantages = [];
    if (largest?.cents) {
        const compare = cheapest && cheapest.band !== largest.band && largest.cents > cheapest.cents * 1.3 ? `, nearly ${largest.cents / cheapest.cents >= 1.8 ? "double" : `${trim(largest.cents / cheapest.cents, 1)}×`} the ${BAND_LABELS[cheapest.band].toLowerCase()} rate` : "";
        advantages.push({
            title: `Most of your power is ${largestLabel}`,
            body: `The ${noun} uses ~${whole(usage.kwhPerDay)} kWh a day and ${largestPct}% of it is billed ${largestLabel}. On this tariff ${largestLabel} costs ~${cents(largest.cents)}/kWh${compare}. That is ~${money(largest.cost, false)} a year of ${largestLabel} energy alone.`,
        });
    } else {
        advantages.push({ title: "Know where your power goes", body: `The ${noun} uses ~${whole(usage.kwhPerDay)} kWh a day, about ${approx(usage.annualKwh)} kWh a year.` });
    }
    if (hasSolar) {
        const share = usage.annualKwh > 0 ? Math.round((savings.annualGenerationKwh / usage.annualKwh) * 100) : 0;
        advantages.push({
            title: "Generate your own power",
            body: `${usage.exportPerDay > 0.5 ? "" : `The ${noun} buys 100% of its power from the grid today. `}${kw} kW of new ${mountingOf(input)} solar produces ~${approx(savings.annualGenerationKwh)} kWh a year, about ${share}% of the ${noun}'s ~${approx(usage.annualKwh)} kWh annual usage.`,
        });
    }
    const peak = cost.bands.find((b) => b.band === "peak" && b.cents);
    if (hasBattery && daily)
        advantages.push({
            title: "Power through the night",
            body: `The ${trim(sys.nominalKwh, 1)} kWh battery stores surplus solar${topUp ? `, tops up from ${retailer ? `${retailer}'s` : "the"} ${trim(savings.topUpRateCents, 0)}c ${savings.topUpBand === "offPeak" ? "off-peak" : savings.topUpBand === "flat" ? "usage" : "shoulder"} rate when needed,` : ""} and runs the ${noun} through the ${peak ? `${peakShort} peak` : "evening"} and into the night.`,
        });
    else if (peak && hasBattery)
        advantages.push({
            title: `Beat the ${peakShort} peak`,
            body: `Peak power costs ~${cents(peak.cents)}/kWh, ${peakWindow}${cheapest ? `, about ${trim(peak.cents / cheapest.cents, 0)} times the ~${cents(cheapest.cents)} ${BAND_LABELS[cheapest.band].toLowerCase()} rate` : ""}. The battery covers this window, so less energy is bought at the highest rate.`,
        });
    if (inc.total > 0) {
        // "NSW PRCs and federal solar STCs", "NSW PRCs plus federal battery and solar STCs"
        const stcs = inc.batteryStc.count && inc.solarStc.count ? "federal battery and solar STCs" : inc.batteryStc.count ? "federal battery STCs" : inc.solarStc.count ? "federal solar STCs" : null;
        const named = [inc.prc.count ? "NSW PRCs" : null, stcs].filter(Boolean).join(inc.prc.count && stcs?.includes(" and ") ? " plus " : " and ");
        advantages.push({
            title: "Incentives cut the upfront cost",
            body: `${named} cut the price by ${money(inc.total)}. Choose a ${months}-month payment plan or pay outright with no additional charges.`,
        });
    }
    if (hasBattery && hasSolar && !daily)
        advantages.push({
            title: "Store the midday surplus",
            body: `Solar the ${noun} can't use during the day charges the battery. The stored energy then replaces ${[
                cost.bands.find((b) => b.band === "offPeak" && b.cents) ? `~${cents(cost.bands.find((b) => b.band === "offPeak").cents)} off-peak` : null,
                peak ? `~${cents(peak.cents)} peak` : null,
            ]
                .filter(Boolean)
                .join(" and ")} power, instead of being exported for ~${cents(tariff.feedInCents || 0)}/kWh.`,
        });
    if (hasBattery && daily)
        advantages.push({
            title: "Keep critical loads running",
            body: `A grid outage stops trading. The battery can be configured to keep critical circuits running during an outage, with changeover switchgear quoted separately.`,
        });
    if (ev.included)
        advantages.push({ title: "Earn from EV charging", body: `${sys.evChargers} EV charger${sys.evChargers === 1 ? "" : "s"} could earn ~${money(savings.evIncGst, false)} a year incl. GST at the assumed use — an estimate that depends on how often they are used.` });
    if (ev.future)
        advantages.push({ title: "Ready for EV charging", body: `EVs are a growing share of new car sales. Lower energy costs protect margins today, and the system is sized to add EV charging later.` });
    advantages.push({
        title: "Lower carbon, lower risk",
        body: `${hasBattery && hasSolar ? "Solar and storage" : hasSolar ? "Solar" : "The system"} avoid${hasBattery && hasSolar ? "" : "s"} ~${whole(savings.co2Tonnes)} tonnes of CO2-e a year and reduce${hasBattery && hasSolar ? "" : "s"} how much power the ${noun} buys, so future price rises have less effect on running costs.`,
    });

    // ---- Value adds (page 7) ---------------------------------------------------------------
    const valueAdds = [];
    if (hasBattery) valueAdds.push({ title: "Backup-ready power", body: "The battery can be configured to keep critical circuits running during a grid outage. Backup operation needs changeover switchgear, quoted separately on request." });
    if (ev.future) {
        const headroom = sys.solarInverterKw || sys.inverterKw;
        valueAdds.push({
            title: "Add EV charging later",
            body: `${headroom ? `The ${trim(headroom, 0)} kW ${sys.solarInverterKw ? "inverter" : "power system"} and energy controller leave` : "The energy controller leaves"} headroom to add chargers without raising peak grid demand.`,
        });
        const e = settings.savings.ev;
        valueAdds.push({
            title: "Charging revenue",
            body: `${sys.evChargers === 2 ? "Two" : sys.evChargers} ${evKw} kW charger${sys.evChargers === 1 ? "" : "s"} at $${trim(e.marginPerKwh, 2)}/kWh net, ${e.hoursPerDay} hrs/day, ${e.daysPerWeek} days/week would add ~${money(savings.evPotentialIncGst, false)} a year incl. GST — an estimate that depends on use.`,
        });
    }
    if (hasBattery) valueAdds.push({ title: "Earn from the grid", body: "The battery is VPP-capable and can join virtual power plant and demand response programs, earning payments for supporting the grid at peak times." });
    if (hasBattery && !ev.future)
        valueAdds.push({
            title: "Room to grow",
            body: `A ${trim(sys.solarInverterKw || sys.inverterKw || 0, 0)} kW power system and ~${whole(sys.usableKwh)} kWh of usable storage leave headroom to add EV charging or new site load later.`,
        });
    valueAdds.push({ title: "Protection from rising prices", body: `${hasSolar ? "Solar and stored solar replace" : "The system replaces"} ~${savings.gridOffsetPct}% of the electricity the ${noun} buys today, so future retail and network price rises have less effect on running costs.` });
    valueAdds.push({ title: "Live monitoring & control", body: `The online portal shows ${hasSolar ? "solar generation, " : ""}${hasBattery ? "battery state of charge " : ""}and site load in real time, with alerts and performance reports.` });
    const carbon = {
        title: "Lower carbon footprint",
        body: `${hasSolar ? "Solar replaces" : "The system replaces"} ~${approx(savings.kwhReplaced)} kWh of grid electricity a year, avoiding roughly ${whole(savings.co2Tonnes)} tonnes of CO2-e annually at the NSW grid emissions factor.`,
    };

    // ---- The energy page's notes ----------------------------------------------------------------
    const periods = usage.periods;
    const single = periods.length === 1 ? periods[0] : null;
    const comparison = usage.comparisons?.[0] ?? null;
    const energyNote = [
        input.billNote || (periods.length ? `${periods.length} bill period${periods.length === 1 ? "" : "s"}, ${usage.totalDays} days.` : ""),
        input.annualKwhOverride
            ? `~${approx(usage.annualKwh)} kWh/yr${input.annualKwhBasis ? ` from ${input.annualKwhBasis}` : ""} (~${whole(usage.kwhPerDay)} kWh/day).`
            : single
              ? `~${approx(single.kwh)} kWh in the ${single.days >= 28 && single.days <= 31 ? "month" : `${single.days} days`}, ~${approx(usage.annualKwh)} kWh/yr annualised.`
              : `Average ~${whole(usage.kwhPerDay)} kWh/day (~${approx(usage.annualKwh)} kWh/yr annualised).`,
        usage.exportPerDay > 0.5
            ? `The bills show ~${trim(usage.exportPerDay, 1)} kWh/day of solar export.`
            : hasSolar && usage.exportPerDay === 0 && periods.length
              ? "No solar on site, so all power is bought from the grid."
              : "",
        comparison && comparison.changePct !== null
            ? `*Same period last year${retailer ? `, from the ${retailer} usage comparison` : ""}. Usage is ${comparison.changePct >= 0 ? "up" : "down"} ${trim(Math.abs(comparison.changePct), 1)}% year on year.`
            : comparison
              ? "*Same period last year."
              : "",
    ]
        .filter(Boolean)
        .join(" ");
    const topUpFromCheapest = topUp && cheapest && savings.topUpBand === cheapest.band;
    const moneyNote = [
        `Annualised on ${tariff.ratesNote || "the bill's current rates"}, incl. GST: ~${money(cost.total, false)}/yr.`,
        largest?.cost && cost.total
            ? `${capitalise(largestLabel)} power at ${cents(largest.cents)}/kWh is the ${largest.cost / cost.total >= 0.5 ? "dominant" : "largest"} cost (${Math.round((largest.cost / cost.total) * 100)}%).`
            : "",
        cheapest && largest && cheapest.band !== largest.band
            ? `${capitalise(cheapest.band === "flat" ? "usage" : BAND_LABELS[cheapest.band].toLowerCase())} power at ${cents(cheapest.cents)}/kWh is the cheapest window${topUpFromCheapest || (hasBattery && !daily) ? " and the ideal time to charge the battery" : ""}.`
            : "",
    ]
        .filter(Boolean)
        .join(" ");

    const kind = proposalKind(result);
    return {
        siteNoun: noun,
        headline,
        deliveredBy,
        valueHeadline,
        intro: `Commercial ${kind} Proposal${ev.future ? ", EV-ready" : ""}`,
        whySubtitle: `Advantages of ${[hasSolar ? "solar" : null, hasBattery ? "battery storage" : null, ev.included ? "EV charging" : null].filter(Boolean).join(" and ") || "this system"} for ${input.narrativeHints?.siteDescription || `a ${noun}`}${ev.future ? ", with EV charging as a future add-on" : largest && largestLabel !== "usage" ? ` with a high ${largestLabel} power bill` : ""}`,
        advantages: advantages.slice(0, 6),
        valueAdds: [...valueAdds.slice(0, 5), carbon],
        sources: "",
        energyNote,
        moneyNote,
        equipmentNote: "",
        peakWindow,
        shoulderWindow,
    };
};

/** The PRC sentence of the incentives condition, as the template words it. */
const prcSentence = (inc, sys, s) => {
    const prc = inc.prc;
    const pct = Math.round(s.incentives.usableFraction * 100);
    const usable = `${trim(sys.usableKwh, 1)} kWh usable (${pct}% of ${trim(sys.nominalKwh, 1)} kWh nominal)`;
    const nlf = `${prc.network ? `${prc.network} ` : ""}NLF ${prc.nlf}`;
    const tail = `${s.incentives.prcHours} hrs × ${s.incentives.prcYears} yrs × ${nlf} = ${whole(prc.count)} PRCs, at ${money(prc.price)} each (market price varies).`;
    if (/entered/.test(prc.formula)) return `PRCs under the NSW Peak Demand Reduction Scheme, ${prc.category}: ${usable}, demand-shifting component ${trim(prc.dscKw, 2)} kW × ${tail}`;
    if (prc.category === "BESS5") return `PRCs under the NSW Peak Demand Reduction Scheme, BESS5: ${usable} × ${s.incentives.bess5.kwPerKwh} × ${tail}`;
    return `PRCs under the NSW Peak Demand Reduction Scheme, ${prc.category}: ${usable}, tiered demand-shifting component ${trim(prc.dscKw, 2)} kW × ${tail}`;
};

/** The conditions, exclusions, payment wording and estimates-only notes — always from the figures. */
export const fixedText = ({ input = {}, result, settings, narrative = {} }) => {
    const inc = result.incentives;
    const sys = result.system;
    const sav = result.savings;
    const tariff = input.tariff ?? {};
    const ev = evState(result);
    const networkName = input.site?.network || "the network";
    const network = networkName.replace(/\s*energy$/i, "") + (/(energy)$/i.test(networkName) ? " Energy" : "");
    const s = settings;
    const f = s.finance;
    const minSolar = sys.usableKwh * s.incentives.minSolarToUsableRatio;
    const daily = sav.batteryModel !== "solar_first";
    const solar = input.system?.solar ?? {};

    const incentives = [];
    if (inc.prc.count) incentives.push(`${prcSentence(inc, sys, s)}${inc.prc.category === "BESS4" && inc.batteryStc.count ? " The BESS4 tiering already reduces PRCs for batteries that also receive federal battery STCs." : ""}`);
    if (inc.batteryStc.count) incentives.push(`Battery STCs (Cheaper Home Batteries): ${inc.batteryStc.count} STCs at ${money(inc.batteryStc.price, false)}.`);
    if (inc.solarStc.count) {
        const panels = sys.panelCount && solar.panelWatts ? `${sys.panelCount} × ${trim(solar.panelWatts, 0)} W, ` : "";
        incentives.push(`Solar STCs: ${inc.solarStc.formula.replace(/ = .*/, "")} = ${whole(inc.solarStc.count)} STCs at ${money(inc.solarStc.price, false)} (${panels}within the ${s.incentives.solarStc.maxKw} kW STC limit).`);
    }
    if (!inc.batteryStc.count && sys.nominalKwh > s.incentives.batteryStc.maxNominalKwh) incentives.push(`No battery STCs apply (battery over ${s.incentives.batteryStc.maxNominalKwh} kWh).`);
    if (!incentives.length) incentives.push("No government incentives apply to this system as proposed.");

    const conditions = [{ title: "Incentives", body: incentives.join(" ") }];
    if (sys.usableKwh > 0)
        conditions.push({
            title: "PRC eligibility",
            body: `New solar must be at least a quarter of the usable battery capacity (${trim(sys.solarKw, 2)} kW ${sys.solarKw >= minSolar ? "≥" : "<"} ${trim(minSolar, 1)} kW). The battery must be installed within 90 days of the new solar, on or after 1 September 2026, and must be internet-connectable and controllable for demand response.`,
        });
    conditions.push({
        title: "Timing",
        body: `${sys.usableKwh > 0 && sys.solarKw > 0 ? "Solar and battery installed within 90 days of each other. " : ""}${inc.batteryStc.count ? "Installation by 31 December 2026 to retain the current battery STC factor. " : ""}Subject to ${network} connection approval, including any export limit.`,
    });

    const ratesClause = tariff.ratesNote ? `${tariff.ratesNote}, no price escalation.` : "No price escalation.";
    const solarClause = sys.solarKw
        ? `${displayKw(sys.solarKw)} kW solar ~${approx(sav.annualGenerationKwh)} kWh/yr (${whole(sav.yieldPerKwp)} kWh/kWp, ${sav.yieldProfileName}) against site usage ~${approx(result.usage.annualKwh)} kWh/yr.`
        : `Site usage ~${approx(result.usage.annualKwh)} kWh/yr.`;
    const evClause = sav.evIncGst
        ? `EV revenue: ${sys.evChargers} chargers × ${s.savings.ev.kwEach} kW × ${s.savings.ev.hoursPerDay} h × ${s.savings.ev.daysPerWeek} days × ${s.savings.ev.weeksPerYear} weeks × $${s.savings.ev.marginPerKwh}/kWh net margin — an estimate that depends on use.`
        : "";
    let savingsBasis;
    if (daily) {
        const flows = [
            sys.solarKw ? `~${tens(sav.directKwh)} kWh used directly` : null,
            sys.usableKwh
                ? `battery delivers ~${tens(sav.batteryKwh)} kWh/yr at ${sav.efficiencyPct}% round-trip, capped at the evening/overnight load${sav.topUpKwh > 0 ? `, ${sys.solarKw ? "topped up" : "charged"} from the grid at the ${trim(sav.topUpRateCents, 1)}c ${sav.topUpBand === "offPeak" ? "off-peak" : sav.topUpBand === "flat" ? "usage" : "shoulder"} rate${sys.solarKw ? " when solar is short" : ""} (~${tens(sav.topUpKwh)} kWh/yr imported)` : ""}`
                : null,
            sys.solarKw ? `residual export ~${tens(sav.exportKwh)} kWh at ${trim(tariff.feedInCents || 0, 2)}c/kWh` : null,
        ].filter(Boolean);
        savingsBasis = [solarClause, flows.length ? `${capitalise(flows.join("; "))}.` : "", ratesClause, evClause, "Figures incl. GST."].filter(Boolean).join(" ");
    } else {
        const rateText = [
            tariff.peakCents ? `Peak ${trim(tariff.peakCents, 2)}c` : null,
            tariff.shoulderCents ? `shoulder ${trim(tariff.shoulderCents, 2)}c` : null,
            tariff.offPeakCents ? `off-peak ${trim(tariff.offPeakCents, 2)}c` : null,
            tariff.flatCents ? `usage ${trim(tariff.flatCents, 2)}c` : null,
        ]
            .filter(Boolean)
            .join(", ");
        const shift = sav.lines.find((l) => l.key === "shift");
        savingsBasis = [
            sys.solarKw ? `${trim(sys.solarKw, 2)} kW solar ~${whole(sav.annualGenerationKwh)} kWh/yr (seasonal profile, ~${whole(sav.yieldPerKwp)} kWh/kWp) against site usage ~${whole(result.usage.annualKwh)} kWh/yr.` : `Site usage ~${whole(result.usage.annualKwh)} kWh/yr.`,
            `An estimated ${sav.windowSharePct}% of usage falls in the solar window (to be confirmed with interval data).`,
            sys.solarKw ? `~${whole(sav.directKwh)} kWh used directly at ~${trim(sav.windowRateCents, 1)}c/kWh;` : "",
            sys.usableKwh ? `battery delivers ~${whole(sav.batteryKwh)} kWh/yr of stored solar at ${sav.efficiencyPct}% round-trip, capped at the evening/overnight load${shift ? `, plus ~${whole(shift.kwh)} kWh of ${sav.topUpBand ? BAND_LABELS[sav.topUpBand].toLowerCase() : "grid"} energy shifted into the peak` : ""}.` : "",
            "Any existing solar unchanged.",
            rateText ? `${rateText}/kWh${tariff.supplyCentsPerDay ? `, supply $${(tariff.supplyCentsPerDay / 100).toFixed(4)}/day` : ""}${tariff.feedInCents ? `, solar feed-in ${trim(tariff.feedInCents, 2)}c/kWh` : ""}${tariff.ratesExGst ? " ex GST" : ""}.` : "",
            tariff.ratesNote ? `${tariff.ratesNote}, no price escalation.` : "No price escalation.",
            evClause,
            "Savings will change if the tariff, discount or retailer changes. Figures incl. GST.",
        ]
            .filter(Boolean)
            .join(" ");
    }
    conditions.push({ title: "Savings basis", body: savingsBasis });
    conditions.push({
        title: "Pricing",
        body:
            result.financeMode === "uplift"
                ? `Battery and solar prices include a ${f.financePct}% finance allowance. Option B (pay outright) takes ${f.outrightDiscountPct}% off the net price after incentives.`
                : `Battery and solar prices exclude finance costs. Option A adds a ${f.financePct}% finance cost to the net price after incentives; Option B (pay outright) carries no additional charges.`,
    });
    const surface = mountingOf(input).replace(/rooftop/gi, "roof").replace(/\s*\/\s*/g, "/");
    const equipmentNote = typeof narrative?.equipmentNote === "string" ? narrative.equipmentNote.trim() : "";
    conditions.push({
        title: "Equipment",
        body: `${sys.usableKwh ? "CEC-approved, VPP-capable battery, minimum 10-year warranty (≥70% capacity retained). " : ""}${sys.solarKw ? `Panel layout, ${surface} suitability${result.usage.exportPerDay > 0 ? ", any existing solar integration" : ""} and configuration confirmed at detailed design.` : "Configuration confirmed at detailed design."}${equipmentNote ? ` ${equipmentNote}` : ""}`,
    });
    const ms = result.optionB.milestones.map((m) => `${trim(m.pct, 0)}%`).join(" / ");
    conditions.push({ title: "Payment", body: `Option A: ${f.upfrontPct}% upfront, balance over ${result.optionA.months} equal monthly instalments. Option B: ${ms} milestones.` });

    const exclusions = (s.exclusions ?? []).map((x) => ({ title: x.title, body: String(x.body ?? "").replace(/\{network\}/g, network) }));
    if (ev.future && s.evFutureExclusion && !exclusions.some((x) => /ev/i.test(x.title))) exclusions.push({ ...s.evFutureExclusion });

    const optionAShort = `Option A — ${result.optionA.months}-month plan (${money(result.optionA.total)} incl. GST)`;
    const optionBShort = `Option B — Pay outright (${money(result.optionB.total)} incl. GST)`;
    // "20% is invoiced on signing, 70% on the confirmed installation date and 10% on completion and commissioning"
    const steps = result.optionB.milestones.map((m, i) => {
        const what = m.label.toLowerCase().replace(/^deposit\s+/, "").replace(/^on confirmed\b/, "on the confirmed");
        return i === 0 ? `${trim(m.pct, 0)}% is invoiced ${what}` : `${trim(m.pct, 0)}% ${what}`;
    });
    const msText = steps.length > 1 ? `${steps.slice(0, -1).join(", ")} and ${steps.at(-1)}` : steps[0] ?? "";
    const acceptance = `Please select a payment option below. Under Option A, ${f.upfrontPct}% is invoiced on signing and the balance is paid over ${result.optionA.months} monthly instalments. Under Option B, ${msText}. By signing, the Client accepts this proposal and ${s.company.name.split(" ")[0]}'s Commercial Terms and Conditions (provided with this proposal).`;

    // The bills the savings stand on: "the AGL invoice for 29 Aug–28 Sep 2026".
    const billPeriods = (input.periods ?? []).filter((p) => p.comparison !== true);
    const spans = billPeriods.map(periodText).filter(Boolean);
    const billWord = billPeriods.length > 1 ? "invoices" : "invoice";
    const billBasis = spans.length ? `the ${input.site?.retailer ? `${input.site.retailer} ` : ""}${billWord} for ${spans.length > 1 ? `${spans[0]} to ${spans.at(-1)}` : spans[0]}` : "the electricity bills provided";
    const estimates = [
        {
            title: "ROI & payback",
            body: `Savings, return on investment (ROI) and payback figures are indicative estimates only. They are based on ${billBasis} and current tariffs with no price escalation; actual results will vary with site usage, weather, tariffs and system performance. They are not guarantees and are not financial advice.`,
        },
        {
            title: "PRCs & STCs",
            body: "PRC and STC quantities, certificate prices and the resulting incentive amounts are indicative estimates only. Government rebate schemes (the NSW Peak Demand Reduction Scheme and the federal Small-scale Renewable Energy Scheme) and certificate prices change frequently, so the incentives and net price shown may change.",
        },
        {
            title: "Final calculation",
            body: "The actual PRC and STC amounts will be calculated at the time of submission, after the work is completed, and shared with the Client before the final milestone payment. All figures are incl. GST unless stated.",
        },
    ];
    const disclaimer = `All figures incl. GST unless stated. Incentive and savings figures are indicative estimates (based on ${billBasis}), not guarantees, and are not financial advice. PRC prices are market-based and may change.`;
    const optionANote =
        sav.annualBenefit > 0 && result.optionA.monthly > sav.monthlyBenefit
            ? `During the ${result.optionA.months}-month plan the Option A instalment is higher than the estimated monthly saving, so the plan costs more each month than it saves until it is paid off.`
            : sav.annualBenefit > 0
              ? `The Option A instalment is below the estimated monthly saving, so the system pays for itself month by month from the start.`
              : "";
    const financeNote =
        result.financeMode === "uplift"
            ? `Battery and solar prices include a ${f.financePct}% finance allowance; paying outright takes ${f.outrightDiscountPct}% off the net price.`
            : `System prices exclude finance costs. The ${result.optionA.months}-month payment plan adds a ${f.financePct}% finance cost to the net price after incentives (next page); paying outright carries no additional charges.`;
    const priceNote = [financeNote, inc.total > 0 ? "PRC and STC quantities and values are indicative estimates only; the actual amounts are calculated after the work is completed and shared before the final milestone payment. See Important — Estimates Only on page 6." : ""]
        .filter(Boolean)
        .join("\n");
    const savingsNote = "Savings, ROI and payback are indicative estimates only and are not guaranteed. See Important — Estimates Only on page 6.";

    // Page 7's footnotes.
    const separately = joinAnd([sys.nominalKwh > 0 ? "Backup switchgear" : null, ev.future ? "EV chargers" : null, sys.nominalKwh > 0 ? "VPP enrolment" : null].filter(Boolean));
    const valueFootnote = [
        `Figures are indicative estimates for the proposed ${systemShort(result) || "system"} system detailed on the previous pages.`,
        `Benefits 07–12 are not included in the savings estimate or price.${separately ? ` ${separately} ${separately.includes(" and ") ? "are" : "is"} quoted separately on request.` : ""}`,
    ];

    return { conditions, exclusions, estimates, acceptance, disclaimer, optionAShort, optionBShort, optionANote, priceNote, savingsNote, valueFootnote, network };
};

/**
 * The narrative the PDF prints: the defaults, with the fields a person or the
 * AI set laid over them (a blank field falls back to the default; a list of
 * advantages, value adds or exclusions replaces the default list).
 */
export const effectiveNarrative = ({ input = {}, result, settings, narrative = {} }) => {
    // The site noun ("kitchen", "motel") changes the default sentences, so it is applied before they are written.
    const noun = (typeof narrative?.siteNoun === "string" && narrative.siteNoun.trim()) || input.narrativeHints?.siteNoun;
    const base = defaultNarrative({ input: { ...input, narrativeHints: { ...(input.narrativeHints ?? {}), siteNoun: noun } }, result, settings });
    const fixed = fixedText({ input, result, settings, narrative });
    const out = { ...base, ...fixed };
    for (const key of EDITABLE_NARRATIVE) {
        const value = narrative?.[key];
        if (Array.isArray(value)) {
            const cleaned = value.filter((x) => x && (x.title || x.body)).map((x) => ({ title: String(x.title ?? ""), body: String(x.body ?? "") }));
            if (cleaned.length) out[key] = cleaned.slice(0, key === "exclusions" ? 8 : 6);
        } else if (typeof value === "string" && value.trim()) out[key] = value.trim();
    }
    return out;
};
