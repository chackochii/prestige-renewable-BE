// Calendar dates the server decides on its own — the day a quote is dated, the
// year in a job or purchase-order number, the day a site-visit form was sent,
// the due date a notice quotes — belong to the business unit, in the timezone
// set on it (business_units.timezone), never UTC or the server's own clock.
// At 9 am in Sydney it is still the previous day in UTC, and the server may run
// anywhere.

/** What every unit starts with (the business_units.timezone default). */
export const DEFAULT_TIME_ZONE = "Australia/Sydney";

const formatters = new Map();

/**
 * A date formatter for the zone. The unit's timezone is free text on the
 * settings screen, so one Intl does not know falls back to the default rather
 * than failing the request that needed a date.
 */
const formatterFor = (timeZone) => {
    const wanted = typeof timeZone === "string" && timeZone.trim() ? timeZone.trim() : DEFAULT_TIME_ZONE;
    if (!formatters.has(wanted)) {
        const options = { year: "numeric", month: "2-digit", day: "2-digit" };
        let formatter;
        try {
            formatter = new Intl.DateTimeFormat("en-CA", { ...options, timeZone: wanted });
        } catch {
            formatter = new Intl.DateTimeFormat("en-CA", { ...options, timeZone: DEFAULT_TIME_ZONE });
        }
        formatters.set(wanted, formatter);
    }
    return formatters.get(wanted);
};

/** The unit itself (anything with `timezone`) or the zone name. */
const zoneOf = (unitOrZone) => (typeof unitOrZone === "string" ? unitOrZone : unitOrZone?.timezone);

/** "2026-10-05": the calendar date at `at` (now by default) where the unit is. */
export const unitDate = (unitOrZone, at = new Date()) => {
    const parts = Object.fromEntries(
        formatterFor(zoneOf(unitOrZone))
            .formatToParts(at)
            .map((part) => [part.type, part.value])
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
};

/** "26": the two-digit year at `at` where the unit is — the year in job and purchase-order numbers. */
export const unitYear2 = (unitOrZone, at = new Date()) => unitDate(unitOrZone, at).slice(2, 4);
