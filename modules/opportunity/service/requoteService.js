// Re-quotes: the customer asked for changes to their proposal, so sales sends
// the job back to estimation to be re-priced.
//
//   sales     — from the proposal stage, with the customer's answer in front
//               of them: their message is carried over word for word (as they
//               typed it through the link, or as sales recorded it after a
//               call), sales adds comments for the estimator and picks who
//               gets it. The job moves back to Estimation, the estimator is
//               assigned and told, and the customer's link stops accepting
//               answers — the quote they saw is being redone.
//   estimator — sees the round on the estimation screen (the message, the
//               comments, the version the customer saw), revises the quote and
//               hands it back through the usual "Send to proposal" step with a
//               note on what changed (estimationHandover). That completes the
//               round: the job is back at Proposal and sales sends the revised
//               proposal.
//
// One requote_requests row per round; the open one is also mirrored as
// opportunities.requoteRequestedAt so lists and the board can flag the job
// without a join.

import { Op } from "sequelize";
import db from "../../../models/index.js";
import { parseId } from "../../../utils/ids.js";
import { multiLine, oneLine } from "../../../utils/text.js";
import { notify } from "../../notification/service/notificationService.js";
import { assertAssignable, recordSystemEvent } from "./leadWorkflowService.js";
import { customerLabel } from "./opportunityPeople.js";
import { LIVE_STATUSES } from "../model/proposal.js";

const { Opportunity, Proposal, QuoteVersion, RequoteRequest, BusinessUnit, User, sequelize } = db;

const httpError = (status, message) => Object.assign(new Error(message), { status });

const ESTIMATION_STAGE = 2;
const PROPOSAL_STAGE = 3;

const isBlank = (value) => value === undefined || value === null || String(value).trim() === "";

const money = (value) =>
    value === null || value === undefined
        ? ""
        : new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(Number(value));

const versionLabel = (version) =>
    version ? `${version.quoteNumber || "quote"} v${version.version}${version.grandTotal !== null && version.grandTotal !== undefined ? ` (${money(version.grandTotal)})` : ""}` : "";

// ---- Presenting ---------------------------------------------------------------

const userBrief = (user) => (user ? { id: user.id, name: user.name } : null);
const versionBrief = (version) =>
    version
        ? { id: version.id, version: version.version, quoteNumber: version.quoteNumber, grandTotal: version.grandTotal === null ? null : Number(version.grandTotal) }
        : null;

/** The joins presentRequote reads — shared with the opportunity payload's open round. */
export const REQUOTE_INCLUDE = [
    { model: Proposal, as: "proposal", attributes: ["id", "number", "version", "status"] },
    { model: QuoteVersion, as: "quoteVersion", attributes: ["id", "version", "quoteNumber", "grandTotal"] },
    { model: QuoteVersion, as: "revisedQuoteVersion", attributes: ["id", "version", "quoteNumber", "grandTotal"] },
    { model: User, as: "requestedBy", attributes: ["id", "name"] },
    { model: User, as: "estimator", attributes: ["id", "name"] },
    { model: User, as: "completedBy", attributes: ["id", "name"] },
];

/** A round as both the sales and estimation screens see it. Takes a model row or its plain object. */
export const presentRequote = (row) => ({
    id: row.id,
    opportunityId: row.opportunityId,
    round: row.round,
    status: row.status,
    proposal: row.proposal ? { id: row.proposal.id, number: row.proposal.number, version: row.proposal.version, status: row.proposal.status } : null,
    quoteVersion: versionBrief(row.quoteVersion),
    customerMessage: row.customerMessage,
    customerName: row.customerName,
    customerChannel: row.customerChannel,
    customerRespondedAt: row.customerRespondedAt,
    comments: row.comments,
    requestedBy: userBrief(row.requestedBy),
    requestedAt: row.createdAt,
    estimator: userBrief(row.estimator),
    completedAt: row.completedAt,
    completedBy: userBrief(row.completedBy),
    estimatorNote: row.estimatorNote,
    revisedQuoteVersion: versionBrief(row.revisedQuoteVersion),
});

const loadOpportunity = async (id) => {
    const opportunity = await Opportunity.findByPk(parseId(id, "opportunity id"));
    if (!opportunity) throw httpError(404, "Opportunity not found");
    return opportunity;
};

/** Every round on the job, newest first. */
export const listRequotes = async (id) => {
    const opportunity = await loadOpportunity(id);
    const rows = await RequoteRequest.findAll({
        where: { opportunityId: opportunity.id },
        include: REQUOTE_INCLUDE,
        order: [["round", "DESC"], ["id", "DESC"]],
    });
    return rows.map(presentRequote);
};

/** The round currently with the estimator, or null. */
export const openRequoteFor = (opportunityId) =>
    RequoteRequest.findOne({ where: { opportunityId, status: "open" }, include: REQUOTE_INCLUDE, order: [["id", "DESC"]] });

// ---- Sales: sending the job back -----------------------------------------------

/**
 * { comments, estimatorId?, customerMessage?, customerName? } → the new round.
 *
 * The customer's message is taken from their answer to the latest proposal
 * when they gave one (renegotiate or decline, with a note) — their words, not
 * a paraphrase. Only when there is no recorded answer does `customerMessage`
 * from the body count (what they said on the phone, in sales' words).
 * `estimatorId` defaults to the job's estimator.
 */
export const requestRequote = async (id, payload = {}, actor) => {
    const opportunity = await loadOpportunity(id);
    if (opportunity.lifecycle !== "Active") throw httpError(400, "Only active records can be sent back for a re-quote");
    if (opportunity.stage !== PROPOSAL_STAGE) throw httpError(400, "A re-quote is raised from the proposal stage");

    const unit = await BusinessUnit.findByPk(opportunity.businessUnitId);
    const enabled = (Array.isArray(unit?.enabledStages) ? unit.enabledStages : []).map(Number);
    if (enabled.length && !enabled.includes(ESTIMATION_STAGE))
        throw httpError(400, "Estimation is not enabled for this business unit, so there is nowhere to send a re-quote");
    if (await RequoteRequest.count({ where: { opportunityId: opportunity.id, status: "open" } }))
        throw httpError(409, "A re-quote is already with the estimator");
    if (await Proposal.count({ where: { opportunityId: opportunity.id, status: "accepted" } }))
        throw httpError(409, "The customer has already accepted a proposal on this job");

    const comments = multiLine(payload.comments, 2000);
    if (!comments) throw httpError(400, "Tell the estimator what to change (comments)");

    const estimatorId = isBlank(payload.estimatorId) ? opportunity.estimatorId : payload.estimatorId;
    if (isBlank(estimatorId)) throw httpError(400, "Pick the estimator to assign the re-quote to");
    const estimator = await assertAssignable(estimatorId, opportunity, "estimator");
    const estimatorChanged = opportunity.estimatorId !== estimator.id;

    // The customer's own answer wins over anything typed here.
    const latest = await Proposal.findOne({ where: { opportunityId: opportunity.id }, order: [["version", "DESC"]] });
    const answered = latest && ["renegotiate", "rejected"].includes(latest.response) && latest.responseNote;
    const customer = answered
        ? {
              customerMessage: latest.responseNote,
              customerName: latest.responseName,
              customerChannel: latest.responseChannel,
              customerRespondedAt: latest.respondedAt,
          }
        : {
              customerMessage: multiLine(payload.customerMessage, 2000) || null,
              customerName: oneLine(payload.customerName, 120) || null,
              customerChannel: null,
              customerRespondedAt: null,
          };

    const now = new Date();
    const slaDays = Number(unit?.slaDays?.[ESTIMATION_STAGE] ?? 0);
    const requote = await sequelize.transaction(async (transaction) => {
        // The customer's link stops accepting answers: the quote they saw is
        // being redone, and a revised proposal will bring a new link.
        await Proposal.update(
            { status: "re-estimated" },
            { where: { opportunityId: opportunity.id, status: { [Op.in]: LIVE_STATUSES } }, transaction }
        );
        const round = (await RequoteRequest.count({ where: { opportunityId: opportunity.id }, transaction })) + 1;
        const row = await RequoteRequest.create(
            {
                opportunityId: opportunity.id,
                round,
                status: "open",
                proposalId: latest?.id ?? null,
                quoteVersionId: latest?.quoteVersionId ?? null,
                ...customer,
                comments,
                requestedById: actor?.id ?? null,
                estimatorId: estimator.id,
            },
            { transaction }
        );
        await opportunity.update(
            {
                stage: ESTIMATION_STAGE,
                estimatorId: estimator.id,
                slaStartedAt: now,
                slaDueAt: slaDays ? new Date(now.getTime() + slaDays * 86400000) : null,
                requoteRequestedAt: now,
            },
            { transaction }
        );
        return row;
    });

    const said = customer.customerMessage ? ` Customer's message: "${customer.customerMessage}"` : "";
    if (estimatorChanged) await recordSystemEvent(opportunity, `Estimator assigned: ${estimator.name}`, actor);
    await recordSystemEvent(
        opportunity,
        `Sent back to Estimation for a re-quote (round ${requote.round})${latest ? ` of proposal ${latest.number}` : ""} — assigned to ${estimator.name}.${said} Comments for the estimator: ${comments}`.slice(0, 5000),
        actor
    );
    await notify({
        event: "estimation.requote.requested",
        title: `${opportunity.number}: re-quote requested`,
        body: `${customerLabel(opportunity)} — ${actor?.name || "Sales"} sent ${latest ? `proposal ${latest.number}` : "the job"} back for a re-quote (round ${requote.round}).${said} ${actor?.name || "Sales"} says: ${comments}`,
        userIds: [estimator.id],
        opportunity,
        actor,
    });

    const fresh = await RequoteRequest.findByPk(requote.id, { include: REQUOTE_INCLUDE });
    return presentRequote(fresh);
};

// ---- Estimation: handing the revised quote back ---------------------------------

/**
 * Closes the open round, if there is one, as the job leaves estimation:
 * which saved version it became (the newest when none is named) and the
 * estimator's note on what changed. Called from advanceStage so every way out
 * of stage 2 — the hand-over step or a plain move — completes it. Returns the
 * round, or null when none was open.
 */
export const completeOpenRequote = async (opportunity, actor, { quoteVersionId = null, note = null } = {}) => {
    const open = await openRequoteFor(opportunity.id);
    if (!open) return null;

    const version = quoteVersionId
        ? await QuoteVersion.findOne({ where: { id: quoteVersionId, opportunityId: opportunity.id } })
        : await QuoteVersion.findOne({ where: { opportunityId: opportunity.id }, order: [["version", "DESC"], ["id", "DESC"]] });
    const what = multiLine(note, 2000) || null;

    await open.update({
        status: "completed",
        completedAt: new Date(),
        completedById: actor?.id ?? null,
        estimatorNote: what,
        revisedQuoteVersionId: version?.id ?? null,
    });
    await opportunity.update({ requoteRequestedAt: null });
    await recordSystemEvent(
        opportunity,
        `Re-quote (round ${open.round}) completed${version ? ` — revised ${versionLabel(version)}` : ""}.${what ? ` What changed: ${what}` : ""}`.slice(0, 5000),
        actor
    );
    return open;
};
