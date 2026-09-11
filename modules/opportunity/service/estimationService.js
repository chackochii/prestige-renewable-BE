// Estimation stage (2) workflow on an opportunity: did sales hand over the
// minimum requirements, is more client input needed, the estimator's detailed
// checklist and the pre-site inspection / site-visit assignment. State lives
// on the opportunity row (estimation_* columns); each step is its own
// endpoint so the API can validate and record it independently.
//
// Stage status is derived, never stored (mirrors the frontend's
// estimationState): received null → awaiting requirements · false → on hold ·
// true + clientInfoNeeded false → ready · true → awaiting client input.
import db from "../../../models/index.js";
import { parseId } from "../../../utils/ids.js";
import { assertAssignable, recordSystemEvent } from "./leadWorkflowService.js";

const { Opportunity } = db;

const httpError = (status, message) => Object.assign(new Error(message), { status });

const loadOpportunity = async (id) => {
    const opportunity = await Opportunity.findByPk(parseId(id, "opportunity id"));
    if (!opportunity) throw httpError(404, "Opportunity not found");
    return opportunity;
};

const asBoolean = (value, field, { nullable = false } = {}) => {
    if (value === undefined || value === null) {
        if (nullable) return null;
        throw httpError(400, `${field} is required (true or false)`);
    }
    if (value === true || value === "true") return true;
    if (value === false || value === "false") return false;
    throw httpError(400, `${field} must be true or false`);
};

const text = (value, max) => String(value ?? "").trim().slice(0, max);

/** True once sales' requirements are confirmed and no further client input is pending. */
export const isEstimationReady = (opportunity) =>
    opportunity.estimationRequirementsReceived === true && opportunity.estimationClientInfoNeeded === false;

/**
 * { received: boolean, checklistKeys?: string[], reason?: string }
 * received=false puts estimation on hold with the reason (what sales still
 * owes); received=true confirms it and optionally saves the ticked checklist.
 */
export const submitRequirements = async (id, payload = {}, actor) => {
    const opportunity = await loadOpportunity(id);
    const received = asBoolean(payload.received, "received");

    if (!received) {
        const reason = text(payload.reason, 2000);
        if (!reason) throw httpError(400, "Say what is missing (reason) when sending the lead back to sales");
        await opportunity.update({ estimationRequirementsReceived: false, estimationOnHoldReason: reason });
        await recordSystemEvent(opportunity, `Estimation on hold — sent back to sales: ${reason}`, actor);
        return opportunity.id;
    }

    const update = { estimationRequirementsReceived: true, estimationOnHoldReason: null };
    if (payload.checklistKeys !== undefined) {
        if (!Array.isArray(payload.checklistKeys)) throw httpError(400, "checklistKeys must be an array of keys");
        if (payload.checklistKeys.length > 50) throw httpError(400, "checklistKeys: at most 50 entries");
        update.estimationRequirementsChecklist = [...new Set(payload.checklistKeys.map((k) => text(k, 100)).filter(Boolean))];
    }
    const wasConfirmed = opportunity.estimationRequirementsReceived === true;
    await opportunity.update(update);
    if (!wasConfirmed) await recordSystemEvent(opportunity, "Requirements from sales confirmed by estimation", actor);
    return opportunity.id;
};

/** { needed: boolean } — whether the client must supply more input before estimating. */
export const submitClientInfo = async (id, payload = {}, actor) => {
    const opportunity = await loadOpportunity(id);
    if (opportunity.estimationRequirementsReceived !== true)
        throw httpError(400, "Confirm the requirements from sales before answering the client-input question");
    const needed = asBoolean(payload.needed, "needed");
    const changed = opportunity.estimationClientInfoNeeded !== needed;
    await opportunity.update({ estimationClientInfoNeeded: needed });
    if (changed)
        await recordSystemEvent(
            opportunity,
            needed ? "Awaiting further input from the client" : "Client input confirmed — estimation can proceed",
            actor
        );
    return opportunity.id;
};

/**
 * { checklistValues: { key: answer }, preSiteInspectionRequired: boolean|null,
 *   siteVisitAssigneeId?: number|null, siteVisitCompleted?: boolean|null }
 */
export const submitChecklist = async (id, payload = {}, actor) => {
    const opportunity = await loadOpportunity(id);
    const update = {};

    if (payload.checklistValues !== undefined) {
        const values = payload.checklistValues;
        if (!values || typeof values !== "object" || Array.isArray(values))
            throw httpError(400, "checklistValues must be an object of { key: answer }");
        const entries = Object.entries(values);
        if (entries.length > 50) throw httpError(400, "checklistValues: at most 50 entries");
        update.estimationChecklistValues = Object.fromEntries(
            entries.map(([key, value]) => [text(key, 100), text(value, 2000)]).filter(([key]) => key)
        );
    }
    if (payload.preSiteInspectionRequired !== undefined)
        update.estimationPreSiteInspectionRequired = asBoolean(payload.preSiteInspectionRequired, "preSiteInspectionRequired", { nullable: true });
    if (payload.siteVisitCompleted !== undefined)
        update.estimationSiteVisitCompleted = asBoolean(payload.siteVisitCompleted, "siteVisitCompleted", { nullable: true });
    if (payload.siteVisitAssigneeId !== undefined) {
        const raw = payload.siteVisitAssigneeId;
        if (raw === null || raw === "") update.estimationSiteVisitAssigneeId = null;
        else {
            const user = await assertAssignable(raw, opportunity, "site visit assignee");
            update.estimationSiteVisitAssigneeId = user.id;
            if (opportunity.estimationSiteVisitAssigneeId !== user.id)
                await recordSystemEvent(opportunity, `Site visit assigned to ${user.name}`, actor);
        }
    }
    if (update.estimationPreSiteInspectionRequired === false) {
        // No inspection → no visit to track.
        update.estimationSiteVisitAssigneeId = null;
        update.estimationSiteVisitCompleted = null;
    }
    if (update.estimationSiteVisitCompleted === true && opportunity.estimationSiteVisitCompleted !== true)
        await recordSystemEvent(opportunity, "Pre-site inspection completed", actor);

    await opportunity.update(update);
    return opportunity.id;
};
