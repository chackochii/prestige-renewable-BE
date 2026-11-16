// The energy proposal calculator: plain arithmetic, no model. The same input
// and settings always give the same figures, and every figure the proposal
// prints comes from here — the AI only proposes the input (bill readings, a
// system, prices) and writes the words around the numbers.
//
//   calculateProposal(input, settings) → {
//     usage, cost, system, prices, incentives, net, optionA, optionB,
//     savings, payback, flags, basis
//   }
//
// It follows the Prestige proposal skill (Nov 2026):
//   usage    — day-weighted across the bill periods; band split from them
//   prices   — ex-GST lines shown incl. GST; finance separate_on_net or uplift
//   PRCs     — NSW PDRS: FLOOR(DSC × 6 h × 15 yrs × NLF × 10); BESS4 tiered,
//              BESS5 usable × 0.1; zero unless new solar ≥ ¼ usable capacity
//   STCs     — battery (Cheaper Home Batteries, ≤ 100 kWh) and solar
//              FLOOR(kW × zone × deeming years), solar ≤ 100 kW only
//   options  — A: finance added, 20% upfront, 24 instalments rounded down to
//              the cent, the last absorbs the rest; B: 20 / 70 / 10 milestones
//   savings  — a month-by-month model: solar used in the solar window; the
//              battery (settings.savings.batteryModel) either cycling its
//              usable capacity daily — solar surplus first, topped up from the
//              grid's cheapest band when solar is short, discharging peak first
//              and capped at the evening + overnight load (daily_cycle, the
//              current template) — or storing only the surplus with a separate
//              peak-shifting top-up (solar_first); the rest exported. EV
//              revenue as an estimate (only when the chargers are in the price).
//   payback  — total payable ÷ annual benefit incl. GST, A / B
//
// Rates are as the bill prints them; with tariff.ratesExGst the calculator
// adds GST, so every dollar figure it returns is incl. GST either way.
import { BANDS, DEFAULT_SETTINGS, mergeSettings } from "./proposalDefaults.js";

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const EPS = 1e-9;

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const round = (n, places = 0) => {
    const f = 10 ** places;
    return Math.round((Number(n) + Number.EPSILON) * f) / f;
};
const floorCents = (n) => Math.floor(Number(n) * 100 + EPS) / 100;
const num = (value, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
};
const positive = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
};
const money = (value) =>
    new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value) || 0);
const whole = (value) => new Intl.NumberFormat("en-AU", { maximumFractionDigits: 0 }).format(Math.round(Number(value) || 0));

/** Overlap of [0, amount] with the tier [from, to]. */
const inTier = (amount, from, to) => Math.max(0, Math.min(amount, to) - from);

export const BAND_LABELS = { peak: "Peak", shoulder: "Shoulder", offPeak: "Off-peak", flat: "Usage (flat rate)" };

/** "100" for 99.75 kW, "25" for 25, "60.8" for 60.8 — how headlines name an array (the specification keeps the exact kW). */
export const displayKw = (kw) => {
    const value = Number(kw) || 0;
    const whole = Math.round(value);
    if (whole >= 20 && Math.abs(value - whole) / value <= 0.003) return String(whole);
    const r = Math.round(value * 100) / 100;
    return Number.isInteger(r) ? String(r) : r.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
};

// ---- Usage ------------------------------------------------------------------------

const periodKwh = (p) => positive(p.peakKwh) + positive(p.shoulderKwh) + positive(p.offPeakKwh) + positive(p.flatKwh);

/** Day-weighted annualisation of the bill periods (comparison rows are shown, never counted). */
export const annualiseUsage = (input) => {
    const all = Array.isArray(input.periods) ? input.periods : [];
    const periods = all.filter((p) => p.comparison !== true && positive(p.days) > 0 && periodKwh(p) > 0);
    const totalDays = periods.reduce((s, p) => s + positive(p.days), 0);
    const totals = Object.fromEntries(BANDS.map((b) => [b, periods.reduce((s, p) => s + positive(p[`${b}Kwh`]), 0)]));
    const totalKwh = BANDS.reduce((s, b) => s + totals[b], 0);
    const exportKwh = periods.reduce((s, p) => s + positive(p.exportKwh), 0);
    const billed = periods.filter((p) => positive(p.totalIncGst) > 0);
    const billedDays = billed.reduce((s, p) => s + positive(p.days), 0);
    const billedCost = billed.reduce((s, p) => s + positive(p.totalIncGst), 0);

    const kwhPerDay = totalDays > 0 ? totalKwh / totalDays : 0;
    const override = positive(input.annualKwhOverride);
    const annualKwh = override || kwhPerDay * 365;
    // The band split from the bills; with no bands at all, it is one flat rate.
    const split = totalKwh > 0 ? Object.fromEntries(BANDS.map((b) => [b, totals[b] / totalKwh])) : { peak: 0, shoulder: 0, offPeak: 0, flat: 1 };

    // The bill's same-period-last-year figures: kWh/day then, and the change since.
    const comparisons = all
        .filter((p) => p.comparison === true && positive(p.days) > 0 && (periodKwh(p) > 0 || positive(p.totalKwh) > 0))
        .map((p) => {
            const kwh = periodKwh(p) || positive(p.totalKwh);
            const perDay = kwh / positive(p.days);
            return {
                label: p.label || "",
                days: positive(p.days),
                kwh: round(kwh),
                kwhPerDay: round(perDay, 1),
                changePct: kwhPerDay > 0 && perDay > 0 ? round(((kwhPerDay - perDay) / perDay) * 100, 1) : null,
                comparison: true,
            };
        });

    return {
        periods: periods.map((p) => {
            const kwh = periodKwh(p);
            return {
                label: p.label || "",
                days: positive(p.days),
                kwh: round(kwh),
                kwhPerDay: round(kwh / positive(p.days), 1),
                offPeakPct: kwh > 0 ? round((positive(p.offPeakKwh) / kwh) * 100) : 0,
                peakPct: kwh > 0 ? round((positive(p.peakKwh) / kwh) * 100) : 0,
                exportKwh: round(positive(p.exportKwh)),
                exportPerDay: round(positive(p.exportKwh) / positive(p.days), 2),
                costIncGst: positive(p.totalIncGst) ? round2(p.totalIncGst) : null,
                blendedCents: positive(p.totalIncGst) && kwh > 0 ? round((positive(p.totalIncGst) / kwh) * 100, 1) : null,
                startDate: p.startDate || null,
                endDate: p.endDate || null,
            };
        }),
        comparisons,
        totalDays,
        kwhPerDay: round(override ? override / 365 : kwhPerDay, 1),
        annualKwh: round(annualKwh),
        annualBasis: override ? input.annualKwhBasis || "the annual usage entered" : totalDays ? `${totalDays} days of bills, day-weighted` : "no bills entered",
        split: Object.fromEntries(BANDS.map((b) => [b, round(split[b] * 100, 1)])),
        splitFraction: split,
        exportPerDay: totalDays ? round(exportKwh / totalDays, 2) : 0,
        billedAnnualCost: billedDays ? round2((billedCost / billedDays) * 365) : null,
    };
};

/** What turns a bill's rate into a figure incl. GST: 1 when its rates include GST already. */
const grossUp = (tariff = {}, gstFactor = 1.1) => (tariff.ratesExGst ? gstFactor : 1);

/**
 * The tariff's rates in cents by band, incl. GST (`factor` from grossUp; 1
 * gives them as the bill prints them). A band without a rate is 0.
 */
const ratesOf = (tariff = {}, factor = 1) => ({
    peak: positive(tariff.peakCents) * factor,
    shoulder: positive(tariff.shoulderCents) * factor,
    offPeak: positive(tariff.offPeakCents) * factor,
    flat: positive(tariff.flatCents) * factor,
});

/** What the site pays a year on these rates, by band, plus supply — incl. GST. `cents` is the rate as billed. */
export const annualCost = (usage, tariff = {}, gstFactor = 1.1) => {
    const factor = grossUp(tariff, gstFactor);
    const billed = ratesOf(tariff);
    const bands = BANDS.filter((b) => usage.splitFraction[b] > 0).map((b) => {
        const kwh = usage.annualKwh * usage.splitFraction[b];
        return { band: b, kwh: round(kwh), cents: billed[b] || null, cost: billed[b] ? round((kwh * billed[b] * factor) / 100) : null };
    });
    const supply = positive(tariff.supplyCentsPerDay) ? round((positive(tariff.supplyCentsPerDay) * factor * 365) / 100) : 0;
    const energy = bands.reduce((s, b) => s + (b.cost ?? 0), 0);
    const complete = bands.every((b) => b.cost !== null);
    return {
        bands,
        supply,
        energy: round(energy),
        total: round(energy + supply),
        complete,
        blendedCents: usage.annualKwh > 0 ? round(((energy + supply) / usage.annualKwh) * 100, 1) : null,
        largest: bands.filter((b) => b.cost !== null).sort((a, b) => b.cost - a.cost)[0] ?? null,
    };
};

// ---- System -----------------------------------------------------------------------

const systemOf = (input, settings) => {
    const s = input.system ?? {};
    const battery = s.battery && positive(s.battery.nominalKwh) ? s.battery : null;
    const quantity = battery ? Math.max(1, Math.round(num(battery.quantity, 1))) : 0;
    const nominalKwh = battery ? positive(battery.nominalKwh) * quantity : 0;
    const usableKwh = round(nominalKwh * settings.incentives.usableFraction, 2);
    const solar = s.solar && (positive(s.solar.kw) || (positive(s.solar.panelCount) && positive(s.solar.panelWatts))) ? s.solar : null;
    const panelKw = solar && positive(solar.panelCount) && positive(solar.panelWatts) ? (solar.panelCount * solar.panelWatts) / 1000 : 0;
    const solarKw = solar ? positive(solar.kw) || panelKw : 0;
    const ev = s.ev && positive(s.ev.chargers) ? s.ev : null;
    const inverter = s.inverter && (s.inverter.name || positive(s.inverter.kw)) ? s.inverter : null;
    const { bess4 } = settings.incentives;
    const category = usableKwh <= 0 ? null : usableKwh > bess4.maxUsableKwh ? "BESS5" : usableKwh >= bess4.minUsableKwh ? "BESS4" : "below";
    return {
        battery,
        quantity,
        nominalKwh: round(nominalKwh, 2),
        usableKwh,
        inverterKw: battery ? positive(battery.inverterKw) * quantity : 0,
        category,
        solar,
        solarKw: round(solarKw, 3),
        panelKw: round(panelKw, 3),
        panelCount: solar ? positive(solar.panelCount) || (positive(solar.panelWatts) ? Math.round((solarKw * 1000) / solar.panelWatts) : 0) : 0,
        newSolar: solar ? solar.existing !== true : false,
        inverter,
        // A separately named inverter's kW (×quantity) — the solar array's own, not the battery's PCS.
        solarInverterKw: inverter ? positive(inverter.kw) * Math.max(1, Math.round(num(inverter.quantity, 1))) : 0,
        ev,
        evChargers: ev ? Math.round(positive(ev.chargers)) : 0,
        // EV-ready only: the chargers are a future add-on, outside the price and the savings.
        evFuture: ev ? ev.future === true : false,
        extras: (Array.isArray(s.extras) ? s.extras : []).filter((x) => x && (x.label || positive(x.priceExGst))),
    };
};

// ---- Prices -----------------------------------------------------------------------

const priceLines = (system, input, settings) => {
    const gst = 1 + settings.gstRatePct / 100;
    const uplift = (input.params?.financeMode ?? settings.finance.mode) === "uplift" ? 1 + settings.finance.financePct / 100 : 1;
    const lines = [];
    const add = (key, label, exGst, { uplifted = false } = {}) => {
        const base = num(exGst);
        if (!base) return;
        const ex = round2(base * (uplifted ? uplift : 1));
        lines.push({ key, label, exGst: ex, incGst: round2(ex * gst) });
    };
    const b = system.battery;
    if (b) add("battery", b.lineLabel || `${whole(system.nominalKwh)} kWh ${b.shortName || b.name || "Battery"} Battery Storage System, Supply and Install`, num(b.priceExGst) * system.quantity, { uplifted: true });
    const sol = system.solar;
    const inv = system.inverter;
    if (sol) {
        // "100 kW Solar PV + 110 kW Inverter" when the inverter is priced in with the panels.
        const invName = inv ? `${system.solarInverterKw ? `${round(system.solarInverterKw, 1)} kW ` : ""}${/hybrid/i.test(`${inv.type ?? ""} ${inv.name ?? ""}`) ? "Hybrid " : ""}Inverter` : "";
        const withInverter = inv && !positive(inv.priceExGst) ? ` + ${invName}` : "";
        add("solar", sol.lineLabel || `${displayKw(system.solarKw)} kW Solar PV${withInverter}, Supply and Install`, sol.priceExGst, { uplifted: true });
    }
    if (inv && positive(inv.priceExGst))
        add("inverter", inv.lineLabel || `${inv.name || `${round(positive(inv.kw), 1)} kW inverter`}, Supply and Install`, num(inv.priceExGst) * Math.max(1, Math.round(num(inv.quantity, 1))), { uplifted: true });
    // EV-ready only (future add-on): not priced.
    if (system.ev && !system.evFuture)
        add("ev", `${system.evChargers} × ${system.ev.name || "22 kW AC EV charger"}, Supply and Install`, num(system.ev.priceEachExGst) * system.evChargers);
    system.extras.forEach((x, i) => add(`extra_${i}`, x.label || "Additional item", x.priceExGst));
    const totalIncGst = round2(lines.reduce((s, l) => s + l.incGst, 0));
    const totalExGst = round2(lines.reduce((s, l) => s + l.exGst, 0));
    // The GST inside the incl.-GST total (total ÷ 11 at 10%), as the proposals print it.
    return { lines, totalExGst, totalIncGst, gstIncluded: round2(totalIncGst - totalIncGst / gst), uplift: uplift > 1 };
};

// ---- Incentives --------------------------------------------------------------------

const networkKey = (network) => {
    const text = String(network ?? "").toLowerCase();
    if (text.includes("ausgrid")) return "Ausgrid";
    if (text.includes("endeavour")) return "Endeavour";
    if (text.includes("essential")) return "Essential";
    return null;
};

export const incentivesOf = (system, input, settings) => {
    const inc = settings.incentives;
    const params = input.params ?? {};
    const net = networkKey(input.site?.network);
    const nlf = positive(params.nlf) || (net ? inc.nlf[net] : null) || inc.defaultNlf;
    const flags = [];

    // PRCs (NSW PDRS)
    let prc = { category: system.category, dscKw: 0, count: 0, value: 0, formula: "", eligible: false };
    if (system.usableKwh > 0) {
        const minSolar = system.usableKwh * inc.minSolarToUsableRatio;
        const eligible = system.newSolar && system.solarKw + EPS >= minSolar;
        let dscKw = 0;
        let rule = "";
        if (system.category === "BESS5") {
            dscKw = system.usableKwh * inc.bess5.kwPerKwh;
            rule = `${round(system.usableKwh, 1)} kWh usable × ${inc.bess5.kwPerKwh}`;
        } else if (system.category === "BESS4") {
            dscKw = inc.bess4.tiers.reduce((s, t) => s + inTier(system.usableKwh, num(t.fromKwh), num(t.toKwh)) * num(t.kwPerKwh), 0);
            if (Number.isInteger(inc.bess4.dscDecimals)) dscKw = round(dscKw, inc.bess4.dscDecimals);
            rule = "tiered demand-shifting component";
        }
        if (positive(params.dscKwOverride)) {
            dscKw = positive(params.dscKwOverride);
            rule = "demand-shifting component entered";
        }
        const raw = dscKw * inc.prcHours * inc.prcYears * nlf * inc.prcMultiplier;
        const count = eligible && system.category !== "below" ? Math.floor(raw + EPS) : 0;
        prc = {
            category: system.category,
            dscKw: round(dscKw, 3),
            nlf,
            network: net,
            count,
            price: inc.prcPrice,
            value: round2(count * inc.prcPrice),
            eligible,
            minSolarKw: round(minSolar, 1),
            formula: `${rule}: ${round(dscKw, 2)} kW × ${inc.prcHours} hrs × ${inc.prcYears} yrs × ${net ? `${net} ` : ""}NLF ${nlf} × ${inc.prcMultiplier} = ${whole(Math.floor(raw + EPS))} PRCs`,
        };
        if (system.category === "below") flags.push({ level: "warning", text: `${round(system.usableKwh, 1)} kWh usable is under the ${inc.bess4.minUsableKwh} kWh BESS4 minimum — no commercial PRCs are worked out.` });
        if (!eligible && system.category !== "below")
            flags.push({
                level: "warning",
                text: system.newSolar
                    ? `No PRCs: new solar (${round(system.solarKw, 2)} kW) must be at least a quarter of the usable battery capacity (${round(minSolar, 1)} kW).`
                    : "No PRCs: the battery needs new solar installed with it — existing solar never counts.",
            });
        if (!net) flags.push({ level: "info", text: `Network not recognised — PRCs use the default network loss factor ${inc.defaultNlf}. Confirm the DNSP (Ausgrid, Endeavour or Essential).` });
    }

    // Battery STCs (Cheaper Home Batteries)
    let batteryStc = { count: 0, value: 0, formula: "" };
    const stc = inc.batteryStc;
    if (system.usableKwh > 0 && system.category !== "BESS5" && system.nominalKwh <= stc.maxNominalKwh + EPS) {
        const weighted = stc.tiers.reduce((s, t) => s + inTier(system.usableKwh, num(t.fromKwh), num(t.toKwh)) * num(t.share), 0);
        const count = positive(params.batteryStcOverride) ? Math.floor(positive(params.batteryStcOverride)) : Math.floor(weighted * stc.factor + EPS);
        batteryStc = { count, price: inc.stcPrice, value: round2(count * inc.stcPrice), formula: `${round(weighted, 2)} weighted kWh × factor ${stc.factor} = ${count} STCs` };
    } else if (system.usableKwh > 0) {
        batteryStc.formula = system.category === "BESS5" ? "BESS5 batteries take no battery STCs" : `Over ${stc.maxNominalKwh} kWh nominal — no battery STCs`;
    }

    // Solar STCs
    let solarStc = { count: 0, value: 0, formula: "", zone: null };
    const sol = inc.solarStc;
    const zone = String(input.site?.stcZone ?? sol.defaultZone);
    const zoneFactor = num(sol.zones[zone], sol.zones[String(sol.defaultZone)]);
    if (system.solarKw > 0 && system.newSolar) {
        if (system.solarKw > sol.maxKw + EPS) {
            solarStc.formula = `${round(system.solarKw, 2)} kW is over the ${sol.maxKw} kW STC limit — no solar STCs`;
            flags.push({ level: "warning", text: `Solar is ${round(system.solarKw, 2)} kW — over ${sol.maxKw} kW it gets no STCs. Keep the array at or under ${sol.maxKw} kW (check the panel count).` });
        } else {
            const count = Math.floor(system.solarKw * zoneFactor * sol.deemingYears + EPS);
            solarStc = { count, price: inc.stcPrice, value: round2(count * inc.stcPrice), zone, zoneFactor, formula: `${round(system.solarKw, 2)} kW × ${zoneFactor} (Zone ${zone}) × ${sol.deemingYears} yrs = ${count} STCs` };
        }
    }
    if (system.panelKw > 0 && system.solarKw > 0 && Math.abs(system.panelKw - system.solarKw) / system.solarKw > 0.02)
        flags.push({ level: "warning", text: `The panel count gives ${round(system.panelKw, 2)} kW, not the ${round(system.solarKw, 2)} kW quoted — confirm the array.` });
    if (system.panelKw > sol.maxKw + EPS && system.solarKw <= sol.maxKw + EPS)
        flags.push({ level: "warning", text: `${system.panelCount} panels × ${system.solar.panelWatts} W is ${round(system.panelKw, 2)} kW — over ${sol.maxKw} kW the system loses every STC.` });

    const total = round2(prc.value + batteryStc.value + solarStc.value);
    return { prc, batteryStc, solarStc, total, flags };
};

// ---- Payment options ---------------------------------------------------------------

export const paymentOptions = (netIncGst, settings, params = {}) => {
    const f = { ...settings.finance, ...(params.financeMode ? { mode: params.financeMode } : {}) };
    const gstFactor = 1 + settings.gstRatePct / 100;
    const gstOf = (amount) => round2(amount - amount / gstFactor);
    const months = Math.max(1, Math.round(num(f.months, 24)));

    const financeCost = f.mode === "uplift" ? 0 : round2(netIncGst * (f.financePct / 100));
    const totalA = round2(netIncGst + financeCost);
    const upfront = round2(totalA * (f.upfrontPct / 100));
    const rest = round2(totalA - upfront);
    const monthly = floorCents(rest / months);
    const final = round2(rest - monthly * (months - 1));

    const totalB = f.mode === "uplift" ? round2(netIncGst * (1 - f.outrightDiscountPct / 100)) : round2(netIncGst);
    const milestones = (Array.isArray(f.milestones) && f.milestones.length ? f.milestones : DEFAULT_SETTINGS.finance.milestones).map((m) => ({ label: m.label, pct: num(m.pct) }));
    let allocated = 0;
    const steps = milestones.map((m, i) => {
        const amount = i === milestones.length - 1 ? round2(totalB - allocated) : round2(totalB * (m.pct / 100));
        allocated = round2(allocated + amount);
        return { ...m, amount };
    });

    return {
        mode: f.mode,
        optionA: {
            months,
            financePct: f.mode === "uplift" ? 0 : f.financePct,
            financeCost,
            upfrontPct: f.upfrontPct,
            upfront,
            monthly,
            monthlyExGst: round2(monthly / gstFactor),
            final,
            total: totalA,
            gstIncluded: gstOf(totalA),
        },
        optionB: {
            discountPct: f.mode === "uplift" ? f.outrightDiscountPct : 0,
            milestones: steps,
            total: totalB,
            gstIncluded: gstOf(totalB),
        },
    };
};

// ---- Savings ------------------------------------------------------------------------

const TOP_UP_NAMES = { shoulder: "shoulder", offPeak: "off-peak", flat: "usage" };
const trimNumber = (n, places = 1) => {
    const r = round(n, places);
    return Number.isInteger(r) ? String(r) : r.toFixed(places).replace(/0+$/, "").replace(/\.$/, "");
};

export const savingsOf = (system, usage, tariff, settings, params = {}) => {
    const s = settings.savings;
    const gstFactor = 1 + settings.gstRatePct / 100;
    const factor = grossUp(tariff, gstFactor);
    const rates = ratesOf(tariff, factor); // incl. GST — the arithmetic
    const billed = ratesOf(tariff); // as the bill prints them — the words
    const eff = num(params.batteryEfficiencyPct, s.batteryEfficiencyPct) / 100;
    const share = Math.min(1, Math.max(0, num(params.solarWindowSharePct, s.solarWindowSharePct) / 100));
    const baseProfile = Array.isArray(params.yieldProfile) && params.yieldProfile.length === 12 ? params.yieldProfile : s.yieldProfile;
    // A site yield (kWh/kWp a year) keeps the profile's seasons and scales it to that total.
    const baseYield = baseProfile.reduce((a, b) => a + num(b), 0);
    const targetYield = positive(params.yieldKwhPerKwp);
    const profile = targetYield && baseYield > 0 ? baseProfile.map((v) => (num(v) * targetYield) / baseYield) : baseProfile;
    const feedIn = positive(tariff.feedInCents) * factor;
    const order = params.dischargeOrder || s.dischargeOrder;
    const model = params.batteryModel || s.batteryModel || "daily_cycle";
    const windowOrder = (Array.isArray(s.windowOrder) ? s.windowOrder : DEFAULT_SETTINGS.savings.windowOrder).filter((b) => BANDS.includes(b));
    const peakTopUp = params.peakTopUp ?? s.peakTopUp;

    const L = usage.annualKwh / 365;
    const daily = Object.fromEntries(BANDS.map((b) => [b, L * usage.splitFraction[b]]));
    const W = L * share;

    // The solar window's load, taken from the bands it is billed in.
    const windowFrom = {};
    let left = W;
    for (const b of windowOrder) {
        const take = Math.min(left, daily[b]);
        windowFrom[b] = take;
        left -= take;
    }
    const windowRate = W > 0 ? windowOrder.reduce((sum, b) => sum + windowFrom[b] * (rates[b] || 0), 0) / W : 0;
    // What is left outside the window: the evening + overnight load, by band.
    const evening = Object.fromEntries(BANDS.map((b) => [b, Math.max(0, daily[b] - (windowFrom[b] || 0))]));
    const eveningTotal = BANDS.reduce((sum, b) => sum + evening[b], 0);

    // The cheapest band the battery can be topped up from, outside the peak.
    const topUpBand = ["shoulder", "offPeak", "flat"].filter((b) => rates[b] > 0 && usage.splitFraction[b] > 0).sort((a, b) => rates[a] - rates[b])[0] ?? null;
    const topUpRate = topUpBand ? rates[topUpBand] : 0;
    const usable = system.usableKwh;

    /**
     * Discharges `amount` kWh into what is left of the evening + overnight load
     * (peak first, or spread pro rata), only into bands worth more than
     * `minRate` c/kWh. Takes it off `remaining`; returns the kWh and its value (cents).
     */
    const discharge = (amount, remaining, minRate = -Infinity) => {
        const out = { kwh: 0, value: 0 };
        if (!(amount > 0)) return out;
        const eligible = ["peak", "shoulder", "offPeak", "flat"].filter((b) => remaining[b] > 0 && (rates[b] || 0) > minRate);
        if (order === "pro_rata") {
            const pool = eligible.reduce((sum, b) => sum + remaining[b], 0);
            const take = Math.min(amount, pool);
            for (const b of eligible) {
                const part = pool > 0 ? take * (remaining[b] / pool) : 0;
                remaining[b] -= part;
                out.kwh += part;
                out.value += part * (rates[b] || 0);
            }
            return out;
        }
        let rest = amount;
        for (const b of eligible) {
            const take = Math.min(rest, remaining[b]);
            remaining[b] -= take;
            out.kwh += take;
            out.value += take * (rates[b] || 0);
            rest -= take;
            if (rest <= 0) break;
        }
        return out;
    };

    const t = { generation: 0, direct: 0, directValue: 0, battery: 0, batterySolar: 0, batteryValue: 0, shift: 0, shiftValue: 0, topUpKwh: 0, topUpCost: 0, exported: 0, exportValue: 0 };
    for (let m = 0; m < 12; m++) {
        const days = DAYS_IN_MONTH[m];
        const gen = (system.solarKw * num(profile[m])) / days;
        const direct = Math.min(gen, W);
        const surplus = gen - direct;
        const remaining = { ...evening };
        let solarIn = 0;
        let delivered = 0;
        let fromSolar = 0;
        let value = 0;
        let topUpIn = 0;
        let shift = 0;
        let shiftValue = 0;
        if (model === "solar_first") {
            // Stores only the surplus; spare capacity is filled from the grid's
            // cheapest band for peak-rate energy, only where it pays.
            solarIn = Math.min(surplus, usable);
            const stored = discharge(Math.min(solarIn * eff, eveningTotal), remaining);
            delivered = fromSolar = stored.kwh;
            value = stored.value;
            if (peakTopUp && usable > 0 && topUpBand && rates.peak > 0) {
                const spare = (usable - solarIn) * eff;
                shift = Math.max(0, Math.min(spare, remaining.peak));
                const perKwh = rates.peak - topUpRate / eff;
                if (perKwh > 0) shiftValue = shift * perKwh;
                else shift = 0;
                topUpIn = shift / (eff || 1);
            }
        } else {
            // Cycles its usable capacity every day, capped at the evening +
            // overnight load: the solar surplus first, the grid's cheapest band
            // for the rest — only for energy worth more than it costs to store.
            const cap = Math.min(usable, eveningTotal);
            const stored = discharge(Math.min(surplus * eff, cap), remaining);
            fromSolar = stored.kwh;
            solarIn = eff > 0 ? fromSolar / eff : 0;
            const grid = peakTopUp && topUpBand && eff > 0 ? discharge(cap - fromSolar, remaining, topUpRate / eff) : { kwh: 0, value: 0 };
            delivered = fromSolar + grid.kwh;
            value = stored.value + grid.value;
            topUpIn = eff > 0 ? grid.kwh / eff : 0;
        }
        const exported = Math.max(0, surplus - solarIn);
        t.generation += gen * days;
        t.direct += direct * days;
        t.directValue += (direct * windowRate * days) / 100;
        t.battery += delivered * days;
        t.batterySolar += fromSolar * days;
        t.batteryValue += (value * days) / 100;
        t.shift += shift * days;
        t.shiftValue += (shiftValue * days) / 100;
        t.topUpKwh += topUpIn * days;
        t.topUpCost += model === "solar_first" ? 0 : (topUpIn * topUpRate * days) / 100;
        t.exported += exported * days;
        t.exportValue += (exported * feedIn * days) / 100;
    }

    const ev = settings.savings.ev;
    const evPotentialExGst = system.evChargers
        ? system.evChargers * num(system.ev?.kwEach, ev.kwEach) * ev.hoursPerDay * ev.daysPerWeek * ev.weeksPerYear * ev.marginPerKwh
        : 0;
    // Revenue counts only when the chargers are in the price; an EV-ready site gets it as a potential.
    const evExGst = system.evFuture ? 0 : evPotentialExGst;
    const evIncGst = round(evExGst * gstFactor);

    // "4–8pm" from "4–8pm weekdays"; the top-up band as the bill names it ("10am–2pm shoulder").
    const peakShort = String(tariff.peakWindow || "4–8pm weekdays").replace(/\s*(on\s+)?weekdays?/i, "").trim();
    const topUpName =
        topUpBand === "shoulder" ? `${tariff.shoulderWindow || "10am–2pm"} shoulder` : topUpBand === "offPeak" ? "off-peak" : "grid";
    const topUpRateText = topUpBand ? `${trimNumber(billed[topUpBand], 1)}c ${TOP_UP_NAMES[topUpBand]}` : "";
    const lines = [
        { key: "direct", label: "Solar used directly in daylight hours", kwh: round(t.direct), value: round(t.directValue), cents: t.direct ? round((t.directValue / t.direct) * 100, 1) : null },
    ];
    if (usable > 0 && model === "solar_first") {
        lines.push({ key: "battery", label: `Battery discharge of stored solar, ${rates.peak ? `${peakShort} peak` : "evening"} and overnight`, kwh: round(t.battery), value: round(t.batteryValue), cents: t.battery ? round((t.batteryValue / t.battery) * 100, 1) : null });
        if (t.shift > 0)
            lines.push({
                key: "shift",
                label: `Peak shifting: ${topUpName} grid top-up used in the ${peakShort} peak`,
                kwh: round(t.shift),
                value: round(t.shiftValue),
                cents: round((t.shiftValue / t.shift) * 100, 1),
            });
    } else if (usable > 0) {
        lines.push({ key: "battery", label: `Battery discharge, ${rates.peak ? `${peakShort} peak` : "evening"} and overnight`, kwh: round(t.battery), value: round(t.batteryValue), cents: t.battery ? round((t.batteryValue / t.battery) * 100, 1) : null });
        if (t.topUpKwh >= 0.5)
            lines.push({ key: "topup", label: `Less: battery top-up from the grid at the ${topUpRateText} rate`, kwh: round(t.topUpKwh), value: -round(t.topUpCost), cents: round(topUpRate, 2) });
    }
    lines.push({ key: "export", label: "Residual solar export", kwh: round(t.exported), value: round(t.exportValue), cents: feedIn || null });
    if (evIncGst) lines.push({ key: "ev", label: `EV charging revenue, ${system.evChargers} charger${system.evChargers === 1 ? "" : "s"} (estimate — depends on use)`, kwh: null, value: evIncGst, cents: null });

    const annualBenefit = round(lines.reduce((sum, l) => sum + l.value, 0));
    // Grid energy replaced by solar — directly, and through the battery (not what it stored from the grid).
    const replaced = t.direct + t.batterySolar;
    return {
        lines,
        batteryModel: model,
        annualGenerationKwh: round(t.generation),
        yieldPerKwp: round(profile.reduce((a, b) => a + num(b), 0)),
        yieldProfileName: params.yieldProfileName || s.yieldProfileName || "seasonal profile",
        windowSharePct: round(share * 100),
        windowLoadPerDay: round(W, 1),
        eveningLoadPerDay: round(eveningTotal, 1),
        windowRateCents: round(windowRate, 2),
        topUpBand,
        topUpRateCents: topUpBand ? round(billed[topUpBand], 2) : null,
        topUpKwh: round(t.topUpKwh),
        topUpCost: round(t.topUpCost),
        directKwh: round(t.direct),
        batteryKwh: round(t.battery),
        batterySolarKwh: round(t.batterySolar),
        shiftKwh: round(t.shift),
        exportKwh: round(t.exported),
        evExGst: round(evExGst),
        evIncGst,
        evPotentialIncGst: round(evPotentialExGst * gstFactor),
        annualBenefit,
        annualBenefitExGst: round(annualBenefit / gstFactor),
        monthlyBenefit: round(annualBenefit / 12),
        monthlyBenefitExGst: round(annualBenefit / gstFactor / 12),
        kwhReplaced: round(replaced),
        gridOffsetPct: usage.annualKwh > 0 ? Math.min(100, round((replaced / usage.annualKwh) * 100)) : 0,
        co2Tonnes: round((replaced * settings.savings.emissionsKgPerKwh) / 1000, 1),
        efficiencyPct: round(eff * 100),
        dischargeOrder: order,
    };
};

// ---- Everything ---------------------------------------------------------------------

const WINTER_MONTHS = /(may|jun|jul|aug)/i;

/** input (a proposal's), settings (merged; DEFAULT_SETTINGS when left out) → the full workout. */
export const calculateProposal = (input = {}, settingsIn = DEFAULT_SETTINGS) => {
    const settings = mergeSettings(DEFAULT_SETTINGS, settingsIn);
    const params = input.params ?? {};
    const tariff = input.tariff ?? {};
    const usage = annualiseUsage(input);
    const cost = annualCost(usage, tariff, 1 + settings.gstRatePct / 100);
    const system = systemOf(input, settings);
    const prices = priceLines(system, input, settings);
    const incentives = incentivesOf(system, input, settings);
    const netIncGst = round2(prices.totalIncGst - incentives.total);
    const options = paymentOptions(netIncGst, settings, params);
    const savings = savingsOf(system, usage, tariff, settings, params);
    const benefit = savings.annualBenefit;
    const payback = {
        optionA: benefit > 0 ? round(options.optionA.total / benefit, 2) : null,
        optionB: benefit > 0 ? round(options.optionB.total / benefit, 2) : null,
        returnPctB: options.optionB.total > 0 ? round((benefit / options.optionB.total) * 100) : null,
    };

    // ---- Open items --------------------------------------------------------------
    const flags = [...incentives.flags];
    const periods = Array.isArray(input.periods) ? input.periods : [];
    if (!usage.periods.length && !positive(input.annualKwhOverride)) flags.push({ level: "warning", text: "No bill periods entered — usage, cost and savings cannot be worked out." });
    else if (usage.periods.length === 1) flags.push({ level: "info", text: "One billing period only — the figures are annualised from it. A summer bill or 12 months of data would firm them up." });
    if (usage.periods.length && periods.every((p) => WINTER_MONTHS.test(p.label || "")))
        flags.push({ level: "info", text: "Winter bills only — the savings are likely conservative; ask for a summer bill." });
    const exports = usage.periods.map((p) => p.exportPerDay);
    if (exports.length > 1 && Math.max(...exports) > 1 && Math.min(...exports) < Math.max(...exports) * 0.3)
        flags.push({ level: "warning", text: "Solar export differs a lot between the bills — check for existing solar or a metering issue." });
    if (usage.exportPerDay > 1) flags.push({ level: "info", text: `The bills show ~${usage.exportPerDay} kWh/day exported — there is existing solar. Confirm its size; it does not count towards the incentives.` });
    if (!cost.complete || !BANDS.some((b) => positive(tariff[`${b}Cents`])))
        flags.push({ level: "warning", text: "Some tariff rates are missing — the cost and savings figures are incomplete." });
    if (tariff.demandNote) flags.push({ level: "info", text: `Demand tariff (${tariff.demandNote}): demand-charge shaving is not in the savings — add it separately.` });
    if (system.usableKwh > 0 && savings.eveningLoadPerDay > 0 && system.usableKwh * (savings.efficiencyPct / 100) > savings.eveningLoadPerDay * 1.05)
        flags.push({ level: "warning", text: `Usable battery (${round(system.usableKwh)} kWh) is more than the evening + overnight load (~${round(savings.eveningLoadPerDay)} kWh/day) — the extra only shifts cheap off-peak energy, a sign of oversizing.` });
    if (system.usableKwh > 0 && incentives.prc.count > 0 && netIncGst / (1 + settings.gstRatePct / 100) < settings.incentives.minClientContributionExGst)
        flags.push({ level: "warning", text: `The client contribution is under the ${money(settings.incentives.minClientContributionExGst)} ex-GST minimum the PRCs require.` });
    if (benefit > 0 && options.optionA.monthly > savings.monthlyBenefit)
        flags.push({ level: "info", text: `Option A's instalment (${money(options.optionA.monthly)}) is more than the average monthly saving (~${money(savings.monthlyBenefit)}) during the plan.` });
    if (savings.evIncGst) flags.push({ level: "info", text: "EV revenue is an estimate that depends on how much the chargers are used." });
    if (system.evFuture) flags.push({ level: "info", text: "EV charging is shown as a future add-on: not in the price or the savings, listed in the exclusions." });
    if (usage.comparisons.length && !usage.periods.length) flags.push({ level: "warning", text: "Only comparison (last-year) periods are entered — add the current bill's periods." });
    if (!input.client?.abn) flags.push({ level: "info", text: "Client ABN is missing." });
    if (!input.site?.nmi) flags.push({ level: "info", text: "NMI is missing — it is on the bill." });
    if (!input.site?.address) flags.push({ level: "warning", text: "Site (supply) address is missing — use the metered address from the bill." });
    for (const line of prices.lines) if (!line.exGst) flags.push({ level: "warning", text: `${line.label} has no price.` });
    if (!prices.lines.length) flags.push({ level: "warning", text: "No system priced yet — add a battery, solar or other line." });

    return {
        calculatedAt: new Date().toISOString(),
        usage,
        cost,
        system: {
            nominalKwh: system.nominalKwh,
            usableKwh: system.usableKwh,
            inverterKw: system.inverterKw,
            category: system.category,
            solarKw: system.solarKw,
            panelKw: system.panelKw,
            panelCount: system.panelCount,
            solarInverterKw: system.solarInverterKw,
            evChargers: system.evChargers,
            evFuture: system.evFuture,
            annualGenerationKwh: savings.annualGenerationKwh,
            yieldPerKwp: savings.yieldPerKwp,
        },
        prices,
        incentives: { prc: incentives.prc, batteryStc: incentives.batteryStc, solarStc: incentives.solarStc, total: incentives.total },
        net: { incGst: netIncGst, exGst: round2(netIncGst / (1 + settings.gstRatePct / 100)) },
        financeMode: options.mode,
        optionA: options.optionA,
        optionB: options.optionB,
        savings,
        payback,
        flags,
    };
};
