// Sydpro approval workflow rules (RACI review, Sep 2026) that role grants
// alone cannot express. Any endpoint that approves a variation or a purchase
// order MUST run these checks — the RBAC grant (e.g. procurement.approve)
// only says a role may approve in general; this policy decides whether THIS
// actor may approve THIS record.

import { SUPER_ROLE_CODE } from "../../role/service/roleService.js";

const httpError = (status, message) => Object.assign(new Error(message), { status });

const isSuper = (actor) => Array.isArray(actor?.roles) && actor.roles.includes(SUPER_ROLE_CODE);

// Price variations below 5% need Sales & Marketing Manager approval; 5% and
// above need Business Owner AND Sales & Marketing Manager approval.
export const VARIATION_ESCALATION_PERCENT = 5;

/** Role codes that must ALL approve a price variation of the given size. */
export const variationApproverRoles = (changePercent) => {
    const pct = Math.abs(Number(changePercent) || 0);
    return pct < VARIATION_ESCALATION_PERCENT ? ["SMM"] : ["SMM", "BO"];
};

/**
 * Throws unless the actor holds one of the roles required for a variation of
 * this size. Callers approving an escalated (≥5%) variation must also record
 * each required role's sign-off — one SMM approval alone does not accept it.
 */
export const assertMayApproveVariation = (actor, changePercent) => {
    if (isSuper(actor)) return;
    const required = variationApproverRoles(changePercent);
    if (!required.some((code) => actor?.roles?.includes(code)))
        throw httpError(
            403,
            `Price variations of ${Math.abs(Number(changePercent) || 0)}% require approval by: ${required.join(" + ")}`
        );
};

/**
 * A purchase order may not be approved by the user who created it — POs
 * raised by the Procurement Manager need a separate reviewer.
 */
export const assertNotPurchaseOrderSelfApproval = (actor, purchaseOrder) => {
    if (!actor || !purchaseOrder?.createdById) return;
    if (Number(actor.id) === Number(purchaseOrder.createdById))
        throw httpError(403, "A purchase order must be approved by someone other than its creator");
};
