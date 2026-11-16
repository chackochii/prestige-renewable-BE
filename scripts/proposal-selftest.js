// Checks the energy proposal calculator against figures confirmed in sent
// Prestige proposals — the counterpart of the skill's scripts/selftest.py.
// Run it after any change to modules/energyProposal/service/proposalCalculator.js
// or to the default settings:
//
//   npm run proposal:selftest
//
// Prices, incentives, payment options and payback are exact (cent for cent).
// The savings model is checked loosely: it follows the skill's stated rules,
// which the original calc.py may apply differently in detail.
import { calculateProposal } from "../modules/energyProposal/service/proposalCalculator.js";
import { DEFAULT_SETTINGS, mergeSettings } from "../modules/energyProposal/service/proposalDefaults.js";
import { effectiveNarrative, shortClientName } from "../modules/energyProposal/service/proposalNarrative.js";

let failed = 0;
let passed = 0;
const eq = (label, actual, expected) => {
    if (Math.abs(Number(actual) - Number(expected)) < 0.005) passed += 1;
    else {
        failed += 1;
        console.log(`✗ ${label}: got ${actual}, expected ${expected}`);
    }
};
const near = (label, actual, expected, tolerancePct) => {
    const off = Math.abs(actual - expected) / expected;
    if (off <= tolerancePct / 100) passed += 1;
    else {
        failed += 1;
        console.log(`✗ ${label}: got ${actual}, expected ~${expected} (±${tolerancePct}%)`);
    }
};

// ---- Jijos Kitchen, Wentworthville (QN202611060039-S, 6 Nov 2026) --------------
const jijos = calculateProposal(
    {
        client: { name: "Jijos Kitchen Pty Ltd", abn: "83 665 992 398" },
        site: { address: "Lot HX, 4 Station Street, Wentworthville NSW 2145", nmi: "43100621661", network: "Endeavour Energy", stcZone: 3 },
        // Band kWh in the bills' proportions (peak 16.9%, shoulder 27.1%, off-peak 56%), 92 days.
        periods: [
            { label: "May–Jun 2026", days: 61, peakKwh: 1712, shoulderKwh: 2745, offPeakKwh: 5675, exportKwh: 3, totalIncGst: 3233.6 },
            { label: "Jul 2026", days: 31, peakKwh: 846, shoulderKwh: 1356, offPeakKwh: 2801, exportKwh: 5, totalIncGst: 1576.05 },
        ],
        annualKwhOverride: 62800,
        tariff: { peakCents: 51.09, shoulderCents: 17.5, offPeakCents: 33.3, supplyCentsPerDay: 131.59, feedInCents: 3.3 },
        system: {
            battery: { ...DEFAULT_SETTINGS.products[0], quantity: 1 },
            solar: { name: "Trina Vertex S+ 475 W N-type Panels", kw: 25, panelWatts: 475, panelCount: 53, priceExGst: 19500 },
        },
        // The Jijos proposal was worked with the earlier battery model (stored solar + peak shifting).
        params: { solarWindowSharePct: 40, batteryModel: "solar_first" },
    },
    DEFAULT_SETTINGS
);
eq("Jijos total system price", jijos.prices.totalIncGst, 64900);
eq("Jijos GST included", jijos.prices.gstIncluded, 5900);
eq("Jijos battery line", jijos.prices.lines[0].incGst, 43450);
eq("Jijos solar line", jijos.prices.lines[1].incGst, 21450);
eq("Jijos BESS4 DSC kW", jijos.incentives.prc.dscKw, 5.3);
eq("Jijos PRCs", jijos.incentives.prc.count, 5008);
eq("Jijos PRC value", jijos.incentives.prc.value, 13020.8);
eq("Jijos battery STCs", jijos.incentives.batteryStc.count, 174);
eq("Jijos solar STCs", jijos.incentives.solarStc.count, 172);
eq("Jijos total incentives", jijos.incentives.total, 26168.8);
eq("Jijos net", jijos.net.incGst, 38731.2);
eq("Jijos A finance", jijos.optionA.financeCost, 3873.12);
eq("Jijos A total", jijos.optionA.total, 42604.32);
eq("Jijos A upfront", jijos.optionA.upfront, 8520.86);
eq("Jijos A monthly", jijos.optionA.monthly, 1420.14);
eq("Jijos A monthly ex GST", jijos.optionA.monthlyExGst, 1291.04);
eq("Jijos A final", jijos.optionA.final, 1420.24);
eq("Jijos A GST", jijos.optionA.gstIncluded, 3873.12);
eq("Jijos B deposit", jijos.optionB.milestones[0].amount, 7746.24);
eq("Jijos B install", jijos.optionB.milestones[1].amount, 27111.84);
eq("Jijos B commissioning", jijos.optionB.milestones[2].amount, 3873.12);
eq("Jijos B GST", jijos.optionB.gstIncluded, 3521.02);
near("Jijos solar generation", jijos.savings.annualGenerationKwh, 34412, 1);
near("Jijos solar used directly", jijos.savings.directKwh, 24476, 2);
near("Jijos battery discharge kWh", jijos.savings.batteryKwh, 8943, 2);
near("Jijos peak shifting kWh", jijos.savings.shiftKwh, 3903, 3);
near("Jijos direct-use rate (c)", jijos.savings.lines[0].cents, 22.7, 2);
near("Jijos grid offset %", jijos.savings.gridOffsetPct, 53, 4);
near("Jijos CO2 tonnes", jijos.savings.co2Tonnes, 21, 5);
// The PDF's ~$10,364 values stored solar at ~40c; the skill's peak-first rule values it higher.
near("Jijos annual benefit (loose)", jijos.savings.annualBenefit, 10364, 7);

// ---- Metro Petroleum St Marys (final, QN202611130036-S, 13 Nov 2026) -----------
const metro = calculateProposal(
    {
        site: { network: "Endeavour Energy", stcZone: 3, address: "516-524 Great Western Hwy, St Marys NSW 2760" },
        system: {
            battery: { name: "StarCharge eBOX 266 kWh", nominalKwh: 266, inverterKw: 0, quantity: 1, priceExGst: 89500 },
            solar: { name: "Trina Vertex S+ 475 W", kw: 99.75, panelWatts: 475, panelCount: 210, priceExGst: 75000 },
            inverter: { name: "GoodWe GW100K-ET-G10 C&I hybrid", kw: 100, priceExGst: 0 },
        },
    },
    DEFAULT_SETTINGS
);
eq("Metro battery line", metro.prices.lines[0].incGst, 98450);
eq("Metro solar + inverter line", metro.prices.lines[1].incGst, 82500);
eq("Metro total system price", metro.prices.totalIncGst, 180950);
eq("Metro usable kWh", metro.system.usableKwh, 239.4);
eq("Metro category", metro.system.category === "BESS5" ? 1 : 0, 1);
eq("Metro PRCs", metro.incentives.prc.count, 22623);
eq("Metro PRC value", metro.incentives.prc.value, 58819.8);
eq("Metro battery STCs (none over 100 kWh)", metro.incentives.batteryStc.count, 0);
eq("Metro solar STCs", metro.incentives.solarStc.count, 689);
eq("Metro net", metro.net.incGst, 95948.2);
eq("Metro A total", metro.optionA.total, 105543.02);
eq("Metro A upfront", metro.optionA.upfront, 21108.6);
eq("Metro A monthly", metro.optionA.monthly, 3518.1);
eq("Metro B deposit", metro.optionB.milestones[0].amount, 19189.64);
eq("Metro B install", metro.optionB.milestones[1].amount, 67163.74);
eq("Metro B commissioning", metro.optionB.milestones[2].amount, 9594.82);

// ---- Metro Petroleum St Marys V8 — the current template (QN202611130036-S) ----------
// 261 kWh eBOX + 99.75 kW solar with a 110 kW string inverter, EV-ready (chargers
// later), AGL Smart Saver rates ex GST, PRCs at $2.95 and STCs at $40.
const v8Settings = mergeSettings(DEFAULT_SETTINGS, { incentives: { prcPrice: 2.95, stcPrice: 40 } });
const v8Input = {
    client: { name: "Metro Petroleum St Marys (Maula Buss Pty Ltd)" },
    site: { address: "1/524 Great Western Highway, St Marys NSW 2760", nmi: "43108967582", network: "Endeavour Energy", stcZone: 3, retailer: "AGL", tariffName: "Smart Saver time-of-use tariff" },
    // Sep 2026: 522.6 kWh/day, 73% off-peak; Sep 2025 (the bill's comparison): 487.9 kWh/day.
    periods: [
        { label: "Sep 2026", startDate: "2026-08-29", endDate: "2026-09-28", days: 31, peakKwh: 2205, shoulderKwh: 2208, offPeakKwh: 11788, exportKwh: 0, totalIncGst: 5006.64 },
        { label: "Sep 2025", days: 31, totalKwh: 15124.9, comparison: true },
    ],
    tariff: { peakCents: 38.6, shoulderCents: 10.1, offPeakCents: 29.2, supplyCentsPerDay: 151.43, feedInCents: 3, ratesExGst: true, peakWindow: "4–8pm", shoulderWindow: "10am–2pm", ratesNote: "AGL Smart Saver rates on the Sep 2026 invoice" },
    system: {
        battery: { ...DEFAULT_SETTINGS.products[1], nominalKwh: 261, inverterKw: 0, quantity: 1, priceExGst: 98635 / 1.1, specLabel: "StarCharge eBOX 261 kWh all-in-one commercial BESS with energy controller (ECC)" },
        solar: { name: "Trina Vertex S+ 475 W N-type Panels", kw: 99.75, panelWatts: 475, panelCount: 210, priceExGst: 78920 / 1.1, mounting: "rooftop / canopy" },
        inverter: { name: "GoodWe C&I String Inverter, 110 kW", kw: 110, type: "string", priceExGst: 0, quantity: 1 },
        ev: { name: "22 kW AC EV charger", chargers: 2, kwEach: 22, future: true },
    },
    params: { solarWindowSharePct: 41, yieldKwhPerKwp: 1500, yieldProfileName: "seasonal Western Sydney profile" },
    narrativeHints: { siteNoun: "site", siteDescription: "a 24/7 fuel and convenience site" },
};
const v8 = calculateProposal(v8Input, v8Settings);
eq("V8 battery line", v8.prices.lines[0].incGst, 98635);
eq("V8 solar + inverter line", v8.prices.lines[1].incGst, 78920);
eq("V8 EV-ready is not priced", v8.prices.lines.length, 2);
eq("V8 total system price", v8.prices.totalIncGst, 177555);
eq("V8 GST included", v8.prices.gstIncluded, 16141.36);
eq("V8 usable kWh", v8.system.usableKwh, 234.9);
eq("V8 PRCs", v8.incentives.prc.count, 22198);
eq("V8 PRC value", v8.incentives.prc.value, 65484.1);
eq("V8 battery STCs (none over 100 kWh)", v8.incentives.batteryStc.count, 0);
eq("V8 solar STCs", v8.incentives.solarStc.count, 689);
eq("V8 STC value", v8.incentives.solarStc.value, 27560);
eq("V8 total incentives", v8.incentives.total, 93044.1);
eq("V8 net", v8.net.incGst, 84510.9);
eq("V8 A finance", v8.optionA.financeCost, 8451.09);
eq("V8 A total", v8.optionA.total, 92961.99);
eq("V8 A upfront", v8.optionA.upfront, 18592.4);
eq("V8 A monthly", v8.optionA.monthly, 3098.73);
eq("V8 A final", v8.optionA.final, 3098.8);
eq("V8 A GST", v8.optionA.gstIncluded, 8451.09);
eq("V8 B deposit", v8.optionB.milestones[0].amount, 16902.18);
eq("V8 B install", v8.optionB.milestones[1].amount, 59157.63);
eq("V8 B commissioning", v8.optionB.milestones[2].amount, 8451.09);
eq("V8 B GST", v8.optionB.gstIncluded, 7682.81);
eq("V8 EV revenue not in the savings", v8.savings.evIncGst, 0);
eq("V8 EV potential (value add)", v8.savings.evPotentialIncGst, 7550);
near("V8 annual usage", v8.usage.annualKwh, 190900, 0.5);
eq("V8 off-peak share", v8.usage.periods[0].offPeakPct, 73);
eq("V8 last-year change %", v8.usage.comparisons[0].changePct, 7.1);
near("V8 off-peak cost", v8.cost.bands.find((b) => b.band === "offPeak").cost, 44613, 0.5);
near("V8 shoulder cost", v8.cost.bands.find((b) => b.band === "shoulder").cost, 2891, 0.5);
near("V8 supply cost", v8.cost.supply, 608, 0.5);
near("V8 solar generation", v8.savings.annualGenerationKwh, 150000, 0.5);
near("V8 solar used directly", v8.savings.directKwh, 78250, 1);
near("V8 battery delivers", v8.savings.batteryKwh, 85740, 0.5);
eq("V8 top-up is its own minus line", (v8.savings.lines.find((l) => l.key === "topup")?.value ?? 0) < 0 ? 1 : 0, 1);
near("V8 grid top-up kWh (loose)", v8.savings.topUpKwh, 25510, 20);
near("V8 grid offset %", v8.savings.gridOffsetPct, 74, 6);
near("V8 annual benefit (loose)", v8.savings.annualBenefit, 47155, 7);

const v8Text = effectiveNarrative({ input: v8Input, result: v8, settings: v8Settings, narrative: {} });
const has = (label, text, part) => {
    if (String(text ?? "").includes(part)) passed += 1;
    else {
        failed += 1;
        console.log(`✗ ${label}: "${part}" not in "${text}"`);
    }
};
has("V8 headline", v8Text.headline, "261 kWh StarCharge eBOX Battery Storage + 100 kW New Solar with 110 kW String Inverter · EV-ready");
has("V8 delivered by", v8Text.deliveredBy, "261 kWh battery + 100 kW new solar | EV-ready for future charging");
has("V8 value headline", v8Text.valueHeadline, "More value from a 261 kWh battery + 100 kW solar, including EV charging later");
has("V8 client short name", shortClientName(v8Input.client.name), "Metro Petroleum St Marys");
has("V8 PRC wording", v8Text.conditions[0].body, "BESS5: 234.9 kWh usable (90% of 261 kWh nominal) × 0.1 × 6 hrs × 15 yrs × Endeavour NLF 1.05 = 22,198 PRCs, at $2.95 each (market price varies).");
has("V8 STC wording", v8Text.conditions[0].body, "Solar STCs: 99.75 kW × 1.382 (Zone 3) × 5 yrs = 689 STCs at $40 (210 × 475 W, within the 100 kW STC limit).");
has("V8 no battery STCs", v8Text.conditions[0].body, "No battery STCs apply (battery over 100 kWh).");
has("V8 savings basis", v8Text.conditions.find((c) => c.title === "Savings basis").body, "(1,500 kWh/kWp, seasonal Western Sydney profile)");
has("V8 savings basis top-up", v8Text.conditions.find((c) => c.title === "Savings basis").body, "topped up from the grid at the 10.1c shoulder rate when solar is short");
has("V8 EV exclusion", v8Text.exclusions.map((x) => x.title).join(", "), "EV charging");
has("V8 year-on-year note", v8Text.energyNote, "Usage is up 7.1% year on year.");
has("V8 top-up line", v8.savings.lines.find((l) => l.key === "topup")?.label, "Less: battery top-up from the grid at the 10.1c shoulder rate");
has("V8 estimates basis", v8Text.estimates[0].body, "based on the AGL invoice for 29 Aug–28 Sep 2026");
has("V8 equipment surface", v8Text.conditions.find((c) => c.title === "Equipment").body, "Panel layout, roof/canopy suitability and configuration confirmed at detailed design.");

// 211 panels would push the array over 100 kW and lose every STC — the calculator must say so.
const metro211 = calculateProposal(
    { site: { network: "Endeavour" }, system: { solar: { kw: 100.225, panelWatts: 475, panelCount: 211, priceExGst: 75000 } } },
    DEFAULT_SETTINGS
);
eq("Metro at 211 panels loses STCs", metro211.incentives.solarStc.count, 0);
eq("Metro at 211 panels is flagged", metro211.flags.some((f) => /over 100 kW/.test(f.text)) ? 1 : 0, 1);

// Uplift finance mode: 10% on battery and solar, 10% off for paying outright.
const uplift = calculateProposal({ ...{ site: { network: "Endeavour" } }, system: { battery: { nominalKwh: 100, priceExGst: 39500 }, solar: { kw: 25, priceExGst: 19500 } }, params: { financeMode: "uplift" } }, DEFAULT_SETTINGS);
eq("Uplift battery line", uplift.prices.lines[0].incGst, 47795);
eq("Uplift A has no extra finance", uplift.optionA.financeCost, 0);
eq("Uplift B is 10% off", uplift.optionB.total, Math.round(uplift.net.incGst * 0.9 * 100) / 100);

console.log(`\nproposal self-test: ${passed} passed, ${failed} failed`);
console.log(`Jijos savings with the skill's rules: direct $${jijos.savings.lines[0].value}, battery $${jijos.savings.lines[1].value}, shift $${jijos.savings.lines[2]?.value}, total $${jijos.savings.annualBenefit} (PDF: $5,551 / $3,578 / $1,235 / $10,364)`);
process.exit(failed ? 1 : 0);
