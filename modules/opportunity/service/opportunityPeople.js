// Who is currently on the hook for a record. Used wherever "tell the people
// working on this" is the rule — stage changes, won/lost, SLA breaches.

const OWNER_FIELDS = [
    "leadOwnerId",
    "salespersonId",
    "estimatorId",
    "operationalCoordinatorId",
    "deliveryOwnerId",
];

/** Distinct user ids assigned to the record, in no particular order. */
export const assignedUserIds = (opportunity) => [
    ...new Set(OWNER_FIELDS.map((field) => opportunity?.[field]).filter(Boolean).map(Number)),
];

/** The customer as a notification would name them. */
export const customerLabel = (opportunity) =>
    opportunity?.customerLegalName || opportunity?.customerTradingName || "Customer not named yet";
