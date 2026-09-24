// Who may move a record out of each pipeline stage.
//
// Advancing a stage is the moment one department hands the work to the next, so
// the person doing it has to own the stage being left. The single guard this
// replaces asked only for leads.update or estimation.update, which meant a sales
// representative could drag a job out of Billing or Site works — stages their
// role has nothing to do with.
//
// The values are the same module.action codes the roles screen edits (see
// seeders/roles-permissions.cjs), so which role owns a stage stays data: grant
// invoicing.update to somebody and they can close out billing, with no code
// change. ADM bypasses all of it, as everywhere else.
//
// prestige-fe/src/helpers/stageAccess.js mirrors these maps so the board can
// hide what a person cannot see and grey out what they cannot move. This file
// is the one that decides.

import { userHasPermission } from "../../role/service/roleService.js";

/**
 * Stage number → the permission needed to *see* it: its column on the board,
 * its panel on a record, and records currently sitting in it. Reading a stage
 * is the same department boundary as working it, one step softer — a sales
 * representative follows their own deals but has no business browsing the
 * estimating queue.
 */
export const STAGE_VIEW_PERMISSION = {
    1: "leads.read",
    2: "estimation.read",
    3: "leads.read",
    4: "leads.read",
    5: "approvals.read",
    6: "procurement.read",
    7: "construction.read",
    8: "invoicing.read",
    9: "warranty.read",
};

/** Stage number → the permission needed to move a record out of it. */
export const STAGE_ADVANCE_PERMISSION = {
    1: "leads.update", // sales qualified the lead and assigned an estimator
    2: "estimation.update", // estimation priced it and the quote has items
    3: "leads.update", // sales negotiated the proposal to acceptance
    4: "leads.update", // sales recorded the signed acceptance
    5: "approvals.update", // council, network and rebate approvals gathered
    6: "procurement.update", // purchase orders placed, deliveries confirmed
    7: "construction.update", // site works installed and commissioned
    8: "invoicing.update", // milestone billing reconciled
    9: "warranty.update", // handover pack completed
};

/** Short stage names, so a refusal says "out of Billing" rather than "out of stage 8". */
export const STAGE_LABELS = {
    1: "Lead capture",
    2: "Estimation",
    3: "Proposal",
    4: "Sales closure",
    5: "Approvals",
    6: "Procurement",
    7: "Site works",
    8: "Billing",
    9: "Handover",
};

/**
 * The permission needed to leave `stage`. An unknown stage falls back to
 * leads.update rather than to "anyone" — a stage nobody has mapped yet should
 * be harder to move, not easier.
 */
export const advancePermissionFor = (stage) => STAGE_ADVANCE_PERMISSION[Number(stage)] ?? "leads.update";

/**
 * Every permission that can advance something, for the route-level gate. The
 * route only decides whether to let the request reach the service; the service
 * then checks the one permission that matters for the record's actual stage.
 */
export const ADVANCE_PERMISSIONS = [...new Set(Object.values(STAGE_ADVANCE_PERMISSION))];

/** The permission needed to see `stage`. */
export const viewPermissionFor = (stage) => STAGE_VIEW_PERMISSION[Number(stage)] ?? "leads.read";

/**
 * The stages this person may see, ascending. Everything that lists or filters
 * opportunities narrows to these, so a stage someone cannot read does not reach
 * them as a column, a card or a count.
 */
export const readableStages = async (user) => {
    const stages = Object.keys(STAGE_VIEW_PERMISSION).map(Number).sort((a, b) => a - b);
    const allowed = [];
    for (const stage of stages) if (await userHasPermission(user, viewPermissionFor(stage))) allowed.push(stage);
    return allowed;
};
