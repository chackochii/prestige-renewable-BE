// Holds a proposal's input to its shape — whether it came from the AI or from
// the estimator's edits. Unknown keys go, numbers outside a sensible range
// become null, text is trimmed, and a battery, solar or EV line that names a
// product from the skill's settings picks up that product's details (the
// price only when none was given — the skill says prices are confirmed per job).
import { oneLine, multiLine } from "../../../utils/text.js";
import { BATTERY_MODELS, FINANCE_MODES, DISCHARGE_ORDERS } from "./proposalDefaults.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v, max) => oneLine(v, max) || null;
const n = (v, min, max) => {
    if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
    const x = Number(v);
    return Number.isFinite(x) && x >= min && x <= max ? Math.round(x * 1000) / 1000 : null;
};
const int = (v, min, max) => {
    const x = n(v, min, max);
    return x === null ? null : Math.round(x);
};
const lines = (v, max = 8) => (Array.isArray(v) ? v.map((d) => oneLine(d, 200)).filter(Boolean).slice(0, max) : []);

const productFor = (settings, key, kind) => (key ? (settings.products ?? []).find((p) => p.key === key && (!kind || p.kind === kind)) : null);

const cleanBattery = (raw, settings) => {
    if (!isObj(raw)) return null;
    const product = productFor(settings, raw.productKey, "battery");
    const nominalKwh = n(raw.nominalKwh, 0, 100000) ?? product?.nominalKwh ?? null;
    if (!nominalKwh) return null;
    return {
        productKey: product?.key ?? null,
        name: text(raw.name, 200) || product?.name || "Battery Energy Storage System",
        shortName: text(raw.shortName, 60) || product?.shortName || null,
        nominalKwh,
        inverterKw: n(raw.inverterKw, 0, 100000) ?? product?.inverterKw ?? null,
        quantity: int(raw.quantity, 1, 100) ?? 1,
        priceExGst: n(raw.priceExGst, 0, 100_000_000) ?? product?.priceExGst ?? 0,
        lineLabel: text(raw.lineLabel, 200) || product?.lineLabel || null,
        specLabel: text(raw.specLabel, 300) || product?.specLabel || null,
        description: lines(raw.description).length ? lines(raw.description) : product?.description ?? [],
    };
};

const cleanSolar = (raw, settings) => {
    if (!isObj(raw)) return null;
    const product = productFor(settings, raw.productKey, "solar");
    const kw = n(raw.kw, 0, 100000) ?? product?.kw ?? null;
    const panelWatts = n(raw.panelWatts, 0, 2000) ?? product?.panelWatts ?? null;
    const panelCount = int(raw.panelCount, 0, 100000);
    if (!kw && !(panelCount && panelWatts)) return null;
    return {
        productKey: product?.key ?? null,
        name: text(raw.name, 200) || product?.name || "Solar PV panels",
        kw: kw ?? Math.round(((panelCount * panelWatts) / 1000) * 1000) / 1000,
        panelWatts,
        panelCount: panelCount || (kw && panelWatts ? Math.round((kw * 1000) / panelWatts) : null),
        priceExGst: n(raw.priceExGst, 0, 100_000_000) ?? product?.priceExGst ?? 0,
        existing: raw.existing === true,
        // Where the array goes: "rooftop" (default), "rooftop / canopy", "ground-mounted".
        mounting: text(raw.mounting, 60) || product?.mounting || null,
        lineLabel: text(raw.lineLabel, 200),
        // The specification table's brand / model text, e.g. "Trina Solar Vertex S+ TSM-NEG9RH.28 475 W".
        specLabel: text(raw.specLabel, 300) || product?.specLabel || null,
        description: lines(raw.description).length ? lines(raw.description) : product?.description ?? [],
    };
};

const cleanInverter = (raw) => {
    if (!isObj(raw) || !(text(raw.name, 200) || n(raw.kw, 0, 100000))) return null;
    return {
        name: text(raw.name, 200) || "Hybrid inverter",
        kw: n(raw.kw, 0, 100000),
        // "string" or "hybrid" (named in the headline: "with 110 kW String Inverter").
        type: text(raw.type, 30),
        quantity: int(raw.quantity, 1, 100) ?? 1,
        // 0 = included in the solar price (the usual "solar + inverter" line)
        priceExGst: n(raw.priceExGst, 0, 100_000_000) ?? 0,
        lineLabel: text(raw.lineLabel, 200),
        specLabel: text(raw.specLabel, 300),
        description: lines(raw.description),
    };
};

const cleanEv = (raw, settings) => {
    if (!isObj(raw)) return null;
    const chargers = int(raw.chargers, 0, 200);
    if (!chargers) return null;
    const product = productFor(settings, raw.productKey, "ev") ?? (settings.products ?? []).find((p) => p.kind === "ev");
    return {
        productKey: product?.key ?? null,
        name: text(raw.name, 200) || product?.name || "22 kW AC EV charger",
        chargers,
        kwEach: n(raw.kwEach, 0, 1000) ?? product?.kw ?? 22,
        priceEachExGst: n(raw.priceEachExGst, 0, 10_000_000) ?? product?.priceExGst ?? 0,
        // EV-ready only: chargers can be added later. Not priced, not in the
        // savings; shown as a future add-on and excluded from the price.
        future: raw.future === true,
        description: lines(raw.description, 5),
    };
};

const cleanPeriod = (raw) => {
    if (!isObj(raw)) return null;
    const period = {
        label: text(raw.label, 60) || "",
        startDate: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.startDate ?? "")) ? raw.startDate : null,
        endDate: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.endDate ?? "")) ? raw.endDate : null,
        days: int(raw.days, 1, 400),
        peakKwh: n(raw.peakKwh, 0, 50_000_000),
        shoulderKwh: n(raw.shoulderKwh, 0, 50_000_000),
        offPeakKwh: n(raw.offPeakKwh, 0, 50_000_000),
        flatKwh: n(raw.flatKwh, 0, 50_000_000),
        // A period known only by its total (the bill's same-period-last-year comparison).
        totalKwh: n(raw.totalKwh, 0, 50_000_000),
        exportKwh: n(raw.exportKwh, 0, 50_000_000),
        totalIncGst: n(raw.totalIncGst, 0, 100_000_000),
        // Shown in the energy table for comparison (marked *), never counted in the usage.
        comparison: raw.comparison === true,
        note: text(raw.note, 300),
    };
    return period.days || period.peakKwh || period.offPeakKwh || period.flatKwh || period.shoulderKwh || period.totalKwh ? period : null;
};

export const cleanInput = (raw = {}, settings) => {
    const src = isObj(raw) ? raw : {};
    const client = isObj(src.client) ? src.client : {};
    const site = isObj(src.site) ? src.site : {};
    const tariff = isObj(src.tariff) ? src.tariff : {};
    const system = isObj(src.system) ? src.system : {};
    const params = isObj(src.params) ? src.params : {};
    const hints = isObj(src.narrativeHints) ? src.narrativeHints : {};
    return {
        client: { name: text(client.name, 200), abn: text(client.abn, 20), tradingName: text(client.tradingName, 200) },
        site: {
            address: text(site.address, 300),
            nmi: text(site.nmi, 20),
            network: text(site.network, 80),
            retailer: text(site.retailer, 80),
            tariffName: text(site.tariffName, 200),
            state: text(site.state, 10),
            stcZone: int(site.stcZone, 1, 4) ?? settings.incentives.solarStc.defaultZone,
        },
        periods: (Array.isArray(src.periods) ? src.periods : []).map(cleanPeriod).filter(Boolean).slice(0, 24),
        billNote: multiLine(src.billNote, 600) || null,
        annualKwhOverride: n(src.annualKwhOverride, 0, 100_000_000),
        annualKwhBasis: text(src.annualKwhBasis, 200),
        tariff: {
            peakCents: n(tariff.peakCents, 0, 1000),
            shoulderCents: n(tariff.shoulderCents, 0, 1000),
            offPeakCents: n(tariff.offPeakCents, 0, 1000),
            flatCents: n(tariff.flatCents, 0, 1000),
            supplyCentsPerDay: n(tariff.supplyCentsPerDay, 0, 1_000_000),
            feedInCents: n(tariff.feedInCents, 0, 500),
            // true: the rates (and supply and feed-in) are as the bill prints them
            // ex GST; the calculator adds GST to every dollar figure.
            ratesExGst: tariff.ratesExGst === true,
            peakWindow: text(tariff.peakWindow, 60),
            shoulderWindow: text(tariff.shoulderWindow, 60),
            peakLabelShort: text(tariff.peakLabelShort, 30),
            shoulderLabelShort: text(tariff.shoulderLabelShort, 40),
            offPeakLabelShort: text(tariff.offPeakLabelShort, 40),
            demandNote: text(tariff.demandNote, 200),
            ratesNote: text(tariff.ratesNote, 300),
        },
        system: {
            battery: cleanBattery(system.battery, settings),
            solar: cleanSolar(system.solar, settings),
            inverter: cleanInverter(system.inverter),
            ev: cleanEv(system.ev, settings),
            extras: (Array.isArray(system.extras) ? system.extras : [])
                .filter(isObj)
                .map((x) => ({ label: text(x.label, 200) || "Additional item", priceExGst: n(x.priceExGst, -100_000_000, 100_000_000) ?? 0 }))
                .slice(0, 10),
        },
        params: {
            solarWindowSharePct: n(params.solarWindowSharePct, 0, 100),
            batteryEfficiencyPct: n(params.batteryEfficiencyPct, 10, 100),
            financeMode: FINANCE_MODES.includes(params.financeMode) ? params.financeMode : null,
            dischargeOrder: DISCHARGE_ORDERS.includes(params.dischargeOrder) ? params.dischargeOrder : null,
            peakTopUp: typeof params.peakTopUp === "boolean" ? params.peakTopUp : null,
            batteryModel: BATTERY_MODELS.includes(params.batteryModel) ? params.batteryModel : null,
            // The site's annual solar yield (the seasonal profile is scaled to it) and how the savings basis names it.
            yieldKwhPerKwp: n(params.yieldKwhPerKwp, 500, 2500),
            yieldProfileName: text(params.yieldProfileName, 80),
            nlf: n(params.nlf, 0.5, 2),
            dscKwOverride: n(params.dscKwOverride, 0, 100000),
            batteryStcOverride: int(params.batteryStcOverride, 0, 1_000_000),
        },
        narrativeHints: { siteNoun: text(hints.siteNoun, 40), siteDescription: text(hints.siteDescription, 120) },
    };
};

/** Drops the null params so the calculator falls back to the settings for them. */
export const calculatorInput = (input) => ({
    ...input,
    params: Object.fromEntries(Object.entries(input.params ?? {}).filter(([, v]) => v !== null && v !== undefined)),
});
