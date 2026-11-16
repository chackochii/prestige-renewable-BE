// The calculator settings an energy proposal is worked out with, as they stood
// in the Prestige proposal skill in Nov 2026. Every figure here is editable on
// Admin → AI skills (the skill's `settings`); what an admin saves is merged
// over these defaults (aiSkillService.effectiveSettings), so a setting added
// here later reaches skills saved before it existed.
//
// Two defaults are reconstructions rather than copies, because the skill's
// references/methodology.md (the full formulas) was not available:
//   - incentives.bess4.tiers — the BESS4 tiered demand-shifting component. The
//     single tier reproduces the confirmed Jijos Kitchen figure (90 kWh usable
//     → 5.3 kW → 5,008 PRCs). Replace it with the methodology's tier table.
//   - incentives.batteryStc — the Cheaper Home Batteries tiers (first 14 kWh
//     in full, 14–28 kWh at 60%, 28–50 kWh at 15%) with a 6.8 factor reproduce
//     the confirmed 174 STCs for a 100 kWh battery. Update the factor when the
//     scheme's factor steps down.

/** Average kWh per kWp in each month, Jan → Dec: a seasonal NSW coastal profile, ~1,376 kWh/kWp a year. */
export const NSW_COASTAL_YIELD = [151, 129, 122, 97.5, 83, 70, 78, 99.5, 117, 136.5, 143.5, 149];

export const DEFAULT_SETTINGS = {
    company: {
        name: "Prestige Renewable Solutions",
        abn: "73 632 138 295",
        email: "business@prestigerenewable.com.au",
        website: "prestigerenewable.com.au",
        address: "116/14 Loyalty Rd, North Rocks NSW 2151",
        // The salesperson's name goes on "Prepared by" unless one is set here.
        preparedBy: "",
    },
    quote: { prefix: "QN", suffix: "-S", validityDays: 30 },
    gstRatePct: 10,

    // The products a proposal is built from. Prices are AUD ex GST — the skill
    // says to confirm them per job, so a proposal copies the price and the
    // estimator can change it there.
    products: [
        {
            key: "whes_100",
            kind: "battery",
            name: "WHES PC-mini C&I Energy Storage System",
            shortName: "WHES",
            nominalKwh: 100,
            inverterKw: 50,
            priceExGst: 39500,
            lineLabel: "100 kWh WHES Battery Storage System + ECC, Supply and Install",
            specLabel: "WHES PC-mini C&I Energy Storage System with energy controller (ECC)",
            description: [
                "100 kWh nominal LFP (~90 kWh usable)",
                "50 kW built-in hybrid inverter / PCS",
                "Outdoor all-in-one cabinet, BMS & fire protection",
                "Energy controller (ECC) & monitoring",
            ],
        },
        {
            key: "starcharge_261",
            kind: "battery",
            name: "StarCharge eBOX C&I Energy Storage System",
            shortName: "StarCharge eBOX",
            nominalKwh: 261,
            inverterKw: 125,
            priceExGst: 86500,
            lineLabel: "261 kWh StarCharge eBOX Battery Storage System + ECC, Supply and Install",
            specLabel: "StarCharge eBOX C&I Energy Storage System with energy controller (ECC)",
            description: [
                "261 kWh nominal LFP (~235 kWh usable)",
                "125 kW built-in PCS",
                "Outdoor all-in-one cabinet, BMS & fire protection",
                "Energy controller (ECC) & monitoring",
            ],
        },
        { key: "solar_25", kind: "solar", name: "Trina Vertex S+ 475 W N-type Panels", kw: 25, panelWatts: 475, priceExGst: 19500 },
        { key: "solar_40", kind: "solar", name: "Trina Vertex S+ 475 W N-type Panels", kw: 40, panelWatts: 475, priceExGst: 29600 },
        { key: "solar_60_8", kind: "solar", name: "Trina Vertex S+ 475 W N-type Panels", kw: 60.8, panelWatts: 475, priceExGst: 44850 },
        { key: "solar_66", kind: "solar", name: "Trina Vertex S+ 475 W N-type Panels", kw: 66, panelWatts: 475, priceExGst: 54850 },
        { key: "ev_22", kind: "ev", name: "22 kW AC EV charger", kw: 22, priceExGst: 2150 },
    ],
    // What a solar line says about the panels when nothing else is given.
    solarDescription: [
        "i-TOPCon cells, up to 23.8% efficiency",
        "25-yr product, 30-yr power warranty",
        "Connected to the battery's hybrid inverter",
    ],

    incentives: {
        prcPrice: 2.6,
        stcPrice: 38,
        usableFraction: 0.9,
        minSolarToUsableRatio: 0.25,
        // PRCs = FLOOR(DSC kW × hours × years × NLF × multiplier)
        prcHours: 6,
        prcYears: 15,
        prcMultiplier: 10,
        nlf: { Ausgrid: 1.04, Endeavour: 1.05, Essential: 1.05 },
        defaultNlf: 1.05,
        bess4: {
            minUsableKwh: 20,
            maxUsableKwh: 200,
            tiers: [{ fromKwh: 0, toKwh: 200, kwPerKwh: 0.058889 }],
            dscDecimals: 1,
        },
        bess5: { kwPerKwh: 0.1 },
        batteryStc: {
            factor: 6.8,
            maxNominalKwh: 100,
            tiers: [
                { fromKwh: 0, toKwh: 14, share: 1 },
                { fromKwh: 14, toKwh: 28, share: 0.6 },
                { fromKwh: 28, toKwh: 50, share: 0.15 },
            ],
        },
        solarStc: {
            deemingYears: 5,
            maxKw: 100,
            zones: { 1: 1.622, 2: 1.536, 3: 1.382, 4: 1.185 },
            defaultZone: 3,
        },
        minClientContributionExGst: 5000,
    },

    finance: {
        // separate_on_net (default) | uplift
        mode: "separate_on_net",
        financePct: 10,
        upfrontPct: 20,
        months: 24,
        outrightDiscountPct: 10, // uplift mode only
        milestones: [
            { label: "Deposit on signing", pct: 20 },
            { label: "On confirmed installation date", pct: 70 },
            { label: "On completion and commissioning", pct: 10 },
        ],
    },

    savings: {
        yieldProfile: NSW_COASTAL_YIELD,
        // How the savings basis names the profile ("1,376 kWh/kWp, seasonal NSW coastal profile").
        yieldProfileName: "seasonal NSW coastal profile",
        solarWindowSharePct: 30,
        batteryEfficiencyPct: 90,
        // daily_cycle (the current template, Metro Petroleum V8): the battery
        //   delivers its usable capacity every day, capped at the evening +
        //   overnight load — charged from the solar surplus first and topped up
        //   from the grid's cheapest band when solar is short, where that pays.
        //   The savings show the whole discharge, less the top-up's cost.
        // solar_first (the Jijos Kitchen proposals): the battery stores only the
        //   solar surplus; spare capacity is topped up only for peak-rate
        //   energy, shown as a "peak shifting" line.
        batteryModel: "daily_cycle",
        // false: never charge the battery from the grid.
        peakTopUp: true,
        // peak_first (the skill's rule) | pro_rata (spread over the evening bands)
        dischargeOrder: "peak_first",
        // Which bands the solar window's load is billed in, first to last.
        windowOrder: ["shoulder", "flat", "offPeak", "peak"],
        emissionsKgPerKwh: 0.64,
        ev: { kwEach: 22, hoursPerDay: 4, daysPerWeek: 5, weeksPerYear: 52, marginPerKwh: 0.15 },
    },

    // What every proposal excludes (the exclusions table). A proposal can
    // replace the list with its own (site-specific wording); EV-ready sites
    // get evFutureExclusion added.
    exclusions: [
        { title: "Civil works", body: "Slab/plinth, bollards, trenching, concrete cutting, enclosures or shelters." },
        { title: "Meter upgrades / grid charges", body: "Meter replacement or reconfiguration, and {network} network connection, protection study or augmentation fees." },
        { title: "Permits & approvals", body: "Council planning, certifier and structural engineering fees, including any roof structural assessment (quoted separately on request)." },
        { title: "Switchboard & site works", body: "Switchboard upgrade, asbestos work, roof repairs, and backup/changeover switchgear." },
    ],
    evFutureExclusion: { title: "EV charging", body: "EV chargers, pedestals and cabling (future add-on, quoted separately)." },
};

/** Settings keys the admin screen lists, with the type each holds — used to clean what it sends. */
export const PRODUCT_KINDS = ["battery", "solar", "inverter", "ev", "other"];
export const FINANCE_MODES = ["separate_on_net", "uplift"];
export const DISCHARGE_ORDERS = ["peak_first", "pro_rata"];
export const BATTERY_MODELS = ["daily_cycle", "solar_first"];
export const BANDS = ["peak", "shoulder", "offPeak", "flat"];

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Deep merge: objects merge key by key, anything else (arrays included) replaces. */
export const mergeSettings = (base, override) => {
    if (!isPlainObject(override)) return structuredClone(base);
    const out = structuredClone(base);
    for (const [key, value] of Object.entries(override)) {
        if (value === undefined) continue;
        out[key] = isPlainObject(value) && isPlainObject(out[key]) ? mergeSettings(out[key], value) : structuredClone(value);
    }
    return out;
};
