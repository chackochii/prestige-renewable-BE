// Estimation → Proposal: the estimator sends a saved quote version on to
// sales. It is the stage-2 advance (same permission — estimation.update — and
// the same gates: estimation ready, a priced quote, a saved version) with the
// hand-over said properly: which version and total went, and a note to sales,
// in the job's history and in the salesperson's notification.

import db from "../../../models/index.js";
import { parseId } from "../../../utils/ids.js";
import { advanceStage } from "./opportunityService.js";
import { recordSystemEvent } from "./leadWorkflowService.js";
import { customerLabel } from "./opportunityPeople.js";
import { STAGE_LABELS } from "./stageAccess.js";

const { Opportunity, QuoteVersion } = db;

const httpError = (status, message) => Object.assign(new Error(message), { status });

const ESTIMATION_STAGE = 2;

const money = (value) =>
    value === null || value === undefined
        ? ""
        : new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(Number(value));

const cleanNote = (value) =>
    String(value ?? "")
        .replace(/\r\n?/g, "\n")
        .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060\uFEFF]/g, "")
        .trim()
        .slice(0, 2000);

/**
 * { quoteVersionId?, note? } → the opportunity, now at the next stage.
 * Without quoteVersionId the newest saved version is the one handed over.
 */
export const handOverToProposal = async (id, payload = {}, actor) => {
    const opportunity = await Opportunity.findByPk(parseId(id, "opportunity id"));
    if (!opportunity) throw httpError(404, "Opportunity not found");
    if (opportunity.stage !== ESTIMATION_STAGE) throw httpError(400, "Only a job in estimation can be sent to proposal");

    const version = payload.quoteVersionId
        ? await QuoteVersion.findOne({ where: { id: parseId(payload.quoteVersionId, "quoteVersionId"), opportunityId: opportunity.id } })
        : await QuoteVersion.findOne({ where: { opportunityId: opportunity.id }, order: [["version", "DESC"], ["id", "DESC"]] });
    if (!version)
        throw httpError(
            400,
            payload.quoteVersionId ? "That quote version does not belong to this job" : "Save the quote as a version before sending it to proposal"
        );

    const note = cleanNote(payload.note);
    const quote = `${version.quoteNumber || "Quote"} v${version.version}${version.grandTotal !== null ? ` (${money(version.grandTotal)})` : ""}`;

    // advanceStage checks the permission and every stage-2 gate, then moves
    // the job and tells the people on it — here, that the quote is ready.
    const moved = await advanceStage(opportunity.id, actor, {
        event: "estimation.handover",
        title: `${opportunity.number}: quote ready — send the proposal`,
        body: `${customerLabel(opportunity)} — ${quote} is priced and ready to send to the customer${actor?.name ? `, from ${actor.name}` : ""}.${note ? ` Note: ${note}` : ""}`,
    });

    await recordSystemEvent(
        opportunity,
        `Estimation sent ${quote} to ${STAGE_LABELS[moved.stage] ?? `stage ${moved.stage}`}.${note ? ` Note to sales: ${note}` : ""}`,
        actor
    );
    return moved;
};
