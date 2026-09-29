// Stage 3: the proposal goes to the customer and comes back answered.
//
//   staff  — sales picks a saved quote version and gets the customer's link
//            (sendProposal); the app opens the rep's Gmail with the email
//            ready and the PDF downloaded to attach — nothing is emailed from
//            the server. A newer send withdraws anything still open, so only
//            one link can be answered at a time. If the customer answers by
//            phone instead, sales records it (recordOutcome).
//   public — the link opens the proposal: the PDF is rebuilt in the browser
//            from the quote version's snapshot, exactly as it was sent. The
//            customer accepts (the job moves on to the next stage — Approvals),
//            asks to renegotiate (sales revises and sends a new version), or
//            declines. Each answer notifies the people on the job and lands in
//            the job's history.
//
// The link's token is handed back once, in the send response, and only its
// SHA-256 is stored. Resending a proposal issues a new token, so a lost email
// is fixed by sending again, not by reading the old link back.

import crypto from "node:crypto";
import { Op } from "sequelize";
import db from "../../../models/index.js";
import { parseId } from "../../../utils/ids.js";
import { notify } from "../../notification/service/notificationService.js";
import { recordSystemEvent } from "./leadWorkflowService.js";
import { assignedUserIds, customerLabel } from "./opportunityPeople.js";
import { getOpportunity, listOpportunities, moveToNextStage } from "./opportunityService.js";
import { readableStages } from "./stageAccess.js";
import { OPEN_STATUSES } from "../model/proposal.js";

const { Opportunity, Proposal, QuoteVersion, BusinessUnit, User, sequelize } = db;

const httpError = (status, message) => Object.assign(new Error(message), { status });

/** How long a link can be answered — the same 30 days the quote is valid for. */
export const LINK_DAYS = 30;
const PROPOSAL_STAGE = 3;
/** Proposals that can still change: waiting on the customer, or back with sales to revise. */
const LIVE_STATUSES = [...OPEN_STATUSES, "negotiation"];

// ---- Small helpers ----------------------------------------------------------

const newToken = () => crypto.randomBytes(24).toString("base64url");
const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");
const isWellFormedToken = (token) => typeof token === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(token);

// Control characters never belong in what someone types; newlines survive in
// the longer fields.
const oneLine = (value, max) =>
    String(value ?? "")
        .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060\uFEFF]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max);
const multiLine = (value, max) =>
    String(value ?? "")
        .replace(/\r\n?/g, "\n")
        .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060\uFEFF]/g, "")
        .trim()
        .slice(0, max);

const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;
const isEmail = (value) => typeof value === "string" && value.length <= 254 && EMAIL_RE.test(value);

const money = (value) =>
    value === null || value === undefined
        ? ""
        : new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(Number(value));

const customerFirstName = (opportunity) =>
    opportunity.customerFirstName || opportunity.customerTradingName || opportunity.customerLegalName || "there";

/** Everyone who should hear about the customer's answer: the job's people and whoever sent it. */
const recipientsFor = (opportunity, proposal) => [...new Set([...assignedUserIds(opportunity), proposal.sentById].filter(Boolean))];

const isExpired = (proposal, now = new Date()) => Boolean(proposal.expiresAt) && new Date(proposal.expiresAt) < now;

/** Where the customer's link points. FRONTEND_URL when set, else the app the sender is using. */
const linkFor = (token, linkBase) => {
    const base = String(process.env.FRONTEND_URL || linkBase || "").replace(/\/$/, "");
    if (!/^https?:\/\/[^\s/]+/i.test(base)) throw httpError(500, "FRONTEND_URL is not set, so the proposal link cannot be built");
    return `${base}/proposal/${token}`;
};

// ---- Presenting ---------------------------------------------------------------

const userBrief = (user) => (user ? { id: user.id, name: user.name } : null);

const staffInclude = () => [
    { model: QuoteVersion, as: "quoteVersion", attributes: ["id", "version", "quoteNumber", "grandTotal", "createdAt"] },
    { model: User, as: "sentBy", attributes: ["id", "name"] },
    { model: User, as: "recordedBy", attributes: ["id", "name"] },
];

/** A proposal as staff see it. Never the token: that exists only in the link handed back on sending. */
export const presentProposal = (row) => ({
    id: row.id,
    opportunityId: row.opportunityId,
    number: row.number,
    version: row.version,
    status: row.status,
    expired: OPEN_STATUSES.includes(row.status) && isExpired(row),
    grandTotal: row.grandTotal === null ? null : Number(row.grandTotal),
    quoteVersion: row.quoteVersion
        ? { id: row.quoteVersion.id, version: row.quoteVersion.version, quoteNumber: row.quoteVersion.quoteNumber }
        : null,
    sentTo: row.sentTo,
    sentBy: userBrief(row.sentBy),
    sentAt: row.issuedAt,
    expiresAt: row.expiresAt,
    emailSubject: row.emailSubject,
    emailMessage: row.emailMessage,
    viewedAt: row.viewedAt,
    viewCount: row.viewCount,
    response: row.response,
    respondedAt: row.respondedAt,
    responseName: row.responseName,
    responseNote: row.responseNote,
    responseChannel: row.responseChannel,
    recordedBy: userBrief(row.recordedBy),
    createdAt: row.createdAt,
});

const loadOpportunity = async (id) => {
    const opportunity = await Opportunity.findByPk(parseId(id, "opportunity id"));
    if (!opportunity) throw httpError(404, "Opportunity not found");
    return opportunity;
};

const loadStaffProposal = async (opportunity, proposalId) => {
    const proposal = await Proposal.findOne({
        where: { id: parseId(proposalId, "proposal id"), opportunityId: opportunity.id },
        include: staffInclude(),
    });
    if (!proposal) throw httpError(404, "Proposal not found");
    return proposal;
};

// ---- Staff ----------------------------------------------------------------------

/** Every proposal sent on the job, newest first. */
export const listProposals = async (id) => {
    const opportunity = await loadOpportunity(id);
    const rows = await Proposal.findAll({
        where: { opportunityId: opportunity.id },
        include: staffInclude(),
        order: [["version", "DESC"]],
    });
    return rows.map(presentProposal);
};

/**
 * { quoteVersionId, to?, subject?, message? } → { proposal, link }
 * `to` defaults to the customer's email on the record. The link is returned
 * once: the app puts it in the email it opens in the rep's Gmail. Nothing is
 * sent from here — the subject and message are kept as a record of what the
 * rep was given to send.
 */
export const sendProposal = async (id, payload = {}, actor, { linkBase } = {}) => {
    const opportunity = await loadOpportunity(id);
    if (opportunity.lifecycle !== "Active") throw httpError(400, "Only active records can be sent a proposal");
    if (opportunity.stage !== PROPOSAL_STAGE) throw httpError(400, "Proposals are sent from the proposal stage");

    const quoteVersion = await QuoteVersion.findOne({
        where: { id: parseId(payload.quoteVersionId, "quoteVersionId"), opportunityId: opportunity.id },
    });
    if (!quoteVersion) throw httpError(400, "Pick a saved quote version for this job");

    const to = oneLine(payload.to ?? opportunity.customerEmail, 254).toLowerCase();
    if (!to) throw httpError(400, "The customer has no email address — enter one to send to");
    if (!isEmail(to)) throw httpError(400, "Enter a single valid email address");

    const unit = await BusinessUnit.findByPk(opportunity.businessUnitId);
    const quoteNumber = quoteVersion.quoteNumber || opportunity.number;
    const subject = oneLine(payload.subject, 200) || `Your proposal ${quoteNumber} from ${unit?.name || "Prestige"}`;
    const message = multiLine(payload.message, 5000) || null;

    const token = newToken();
    const now = new Date();
    const proposal = await sequelize.transaction(async (transaction) => {
        // One answerable link at a time: anything still open is replaced.
        await Proposal.update(
            { status: "withdrawn" },
            { where: { opportunityId: opportunity.id, status: { [Op.in]: LIVE_STATUSES } }, transaction }
        );
        const highest = await Proposal.max("version", { where: { opportunityId: opportunity.id }, transaction });
        const version = (Number.isFinite(highest) ? highest : 0) + 1;
        return Proposal.create(
            {
                opportunityId: opportunity.id,
                number: `${opportunity.number}-P${version}`,
                version,
                status: "issued",
                quoteVersionId: quoteVersion.id,
                grandTotal: quoteVersion.grandTotal,
                priceEx: quoteVersion.grandTotal,
                tokenHash: hashToken(token),
                issuedAt: now,
                expiresAt: new Date(now.getTime() + LINK_DAYS * 86400000),
                sentTo: to,
                sentById: actor?.id ?? null,
                emailSubject: subject,
                emailMessage: message,
            },
            { transaction }
        );
    });

    const link = linkFor(token, linkBase);
    await recordSystemEvent(
        opportunity,
        `Proposal ${proposal.number} (quote ${quoteNumber} v${quoteVersion.version}, ${money(proposal.grandTotal)}) prepared for ${to} and opened in the sender's email.`,
        actor
    );

    const fresh = await Proposal.findByPk(proposal.id, { include: staffInclude() });
    return { proposal: presentProposal(fresh), link };
};

/**
 * A fresh link for a still-open proposal — the email was never sent, the
 * customer lost it, or it went to the wrong address ({ to? }). The old link
 * stops working and the 30 days start again.
 */
export const resendProposal = async (id, proposalId, payload = {}, actor, { linkBase } = {}) => {
    const opportunity = await loadOpportunity(id);
    const proposal = await loadStaffProposal(opportunity, proposalId);
    if (!OPEN_STATUSES.includes(proposal.status)) throw httpError(409, "Only a proposal still waiting on the customer can be resent");

    const to = payload.to === undefined ? proposal.sentTo : oneLine(payload.to, 254).toLowerCase();
    if (!isEmail(to)) throw httpError(400, "Enter a single valid email address");

    const token = newToken();
    const now = new Date();
    await proposal.update({ tokenHash: hashToken(token), sentTo: to, issuedAt: now, expiresAt: new Date(now.getTime() + LINK_DAYS * 86400000) });
    const link = linkFor(token, linkBase);
    await recordSystemEvent(opportunity, `Proposal ${proposal.number} resent with a new link to ${to}.`, actor);

    const fresh = await Proposal.findByPk(proposal.id, { include: staffInclude() });
    return { proposal: presentProposal(fresh), link };
};

const DECISIONS = { accept: "accepted", accepted: "accepted", reject: "rejected", rejected: "rejected", renegotiate: "renegotiate" };

/**
 * The customer's answer, applied the same way whether it came through the
 * link or by phone: the proposal's status, the history, the notifications,
 * and — on a yes — the move to the next stage.
 */
const applyResponse = async (opportunity, proposal, { decision, name, note, channel, ip = null, actor = null }) => {
    const now = new Date();
    const status = decision === "accepted" ? "accepted" : decision === "rejected" ? "rejected" : "negotiation";
    await proposal.update({
        status,
        response: decision,
        respondedAt: now,
        responseName: name || null,
        responseNote: note || null,
        responseIp: ip,
        responseChannel: channel,
        recordedById: actor?.id ?? null,
        ...(decision === "accepted" ? { acceptedAt: now } : {}),
        ...(decision === "rejected" ? { rejectionReason: note || null } : {}),
    });

    const who = channel === "customer" ? `${name || "The customer"} (online)` : `${actor?.name || "Sales"}, on the customer's behalf${name ? ` (${name})` : ""}`;
    const said = note ? ` — "${note}"` : "";
    const lines = {
        accepted: [`Proposal ${proposal.number} accepted by ${who}.`, "proposal.accepted", `${opportunity.number}: proposal accepted`],
        renegotiate: [`Proposal ${proposal.number}: ${who} asked to renegotiate${said}.`, "proposal.renegotiate", `${opportunity.number}: customer wants changes`],
        rejected: [`Proposal ${proposal.number} declined by ${who}${said}.`, "proposal.rejected", `${opportunity.number}: proposal declined`],
    };
    const [historyNote, event, title] = lines[decision];
    await recordSystemEvent(opportunity, historyNote, actor);
    await notify({
        event,
        title,
        body:
            decision === "accepted"
                ? `${customerLabel(opportunity)} accepted ${proposal.number} (${money(proposal.grandTotal)}). The job moves on to Approvals.`
                : decision === "renegotiate"
                  ? `${customerLabel(opportunity)} wants changes to ${proposal.number}${said}. Revise the quote and send a new proposal.`
                  : `${customerLabel(opportunity)} declined ${proposal.number}${said}. Send a revised proposal or mark the job lost.`,
        userIds: recipientsFor(opportunity, proposal),
        opportunity,
        actor,
    });

    // A yes moves the job on — if it is still sitting at the proposal stage.
    if (decision === "accepted" && opportunity.lifecycle === "Active" && opportunity.stage === PROPOSAL_STAGE)
        await moveToNextStage(opportunity, actor, { byline: channel === "customer" ? "accepted online by the customer" : null });
};

/** { outcome: accepted | rejected | renegotiate, note?, customerName? } — an answer given by phone or in person. */
export const recordOutcome = async (id, proposalId, payload = {}, actor) => {
    const opportunity = await loadOpportunity(id);
    const proposal = await loadStaffProposal(opportunity, proposalId);
    if (!LIVE_STATUSES.includes(proposal.status)) throw httpError(409, `This proposal is already ${proposal.status}`);

    const decision = DECISIONS[String(payload.outcome ?? "")];
    if (!decision) throw httpError(400, "outcome must be accepted, rejected or renegotiate");
    const note = multiLine(payload.note, 2000);
    if (decision === "renegotiate" && !note) throw httpError(400, "Note what the customer wants changed");

    await applyResponse(opportunity, proposal, { decision, name: oneLine(payload.customerName, 120), note, channel: "staff", actor });
    const fresh = await Proposal.findByPk(proposal.id, { include: staffInclude() });
    return { proposal: presentProposal(fresh), opportunity: await getOpportunity(opportunity.id) };
};

/**
 * The proposals page: every active job at the proposal stage with its latest
 * proposal and latest saved quote, plus proposals answered in the last 30
 * days on jobs the person can still see — so an acceptance does not vanish
 * the moment the job moves on.
 */
export const proposalBoard = async ({ businessUnitId, search } = {}, actor) => {
    const { rows: open } = await listOpportunities(
        { businessUnitId, stage: PROPOSAL_STAGE, lifecycle: "Active", search, pageSize: 200 },
        actor
    );

    const since = new Date(Date.now() - 30 * 86400000);
    const allowed = await readableStages(actor);
    const answered = await Proposal.findAll({
        where: { respondedAt: { [Op.gte]: since }, status: { [Op.in]: ["accepted", "rejected"] } },
        include: [
            {
                model: Opportunity,
                as: "opportunity",
                required: true,
                where: {
                    businessUnitId: parseId(businessUnitId, "business unit id"),
                    stage: { [Op.in]: allowed.length ? allowed : [0] },
                },
            },
        ],
        order: [["respondedAt", "DESC"]],
        limit: 100,
    });

    const opportunities = new Map();
    for (const opportunity of open) opportunities.set(opportunity.id, opportunity);
    for (const proposal of answered) if (!opportunities.has(proposal.opportunityId)) opportunities.set(proposal.opportunityId, proposal.opportunity);
    const ids = [...opportunities.keys()];
    if (!ids.length) return [];

    const [proposals, versions, people] = await Promise.all([
        Proposal.findAll({ where: { opportunityId: { [Op.in]: ids } }, include: staffInclude(), order: [["version", "DESC"]] }),
        QuoteVersion.findAll({
            where: { opportunityId: { [Op.in]: ids } },
            attributes: ["id", "opportunityId", "version", "quoteNumber", "grandTotal", "createdAt"],
            order: [["version", "DESC"], ["id", "DESC"]],
        }),
        User.findAll({
            where: { id: { [Op.in]: [...new Set([...opportunities.values()].map((o) => o.salespersonId).filter(Boolean))] } },
            attributes: ["id", "name"],
        }),
    ]);
    const firstBy = (list) => {
        const map = new Map();
        for (const row of list) if (!map.has(row.opportunityId)) map.set(row.opportunityId, row);
        return map;
    };
    const latestProposal = firstBy(proposals);
    const latestVersion = firstBy(versions);
    const counts = new Map();
    for (const row of proposals) counts.set(row.opportunityId, (counts.get(row.opportunityId) ?? 0) + 1);
    const names = new Map(people.map((user) => [user.id, user.name]));

    return ids.map((oppId) => {
        const opportunity = opportunities.get(oppId);
        const version = latestVersion.get(oppId);
        const proposal = latestProposal.get(oppId);
        return {
            opportunity: {
                id: opportunity.id,
                number: opportunity.number,
                stage: opportunity.stage,
                lifecycle: opportunity.lifecycle,
                customer: customerLabel(opportunity),
                customerFirstName: opportunity.customerFirstName,
                customerLastName: opportunity.customerLastName,
                customerEmail: opportunity.customerEmail,
                siteSuburb: opportunity.siteSuburb,
                salesperson: opportunity.salespersonId ? { id: opportunity.salespersonId, name: names.get(opportunity.salespersonId) ?? null } : null,
                updatedAt: opportunity.updatedAt,
            },
            latestQuoteVersion: version
                ? { id: version.id, version: version.version, quoteNumber: version.quoteNumber, grandTotal: version.grandTotal === null ? null : Number(version.grandTotal), createdAt: version.createdAt }
                : null,
            proposal: proposal ? presentProposal(proposal) : null,
            proposalCount: counts.get(oppId) ?? 0,
        };
    });
};

// ---- Public (the customer's link) ---------------------------------------------

const notFound = () => httpError(404, "This proposal link is not valid. Please use the latest email we sent you.");

const loadByToken = async (token) => {
    if (!isWellFormedToken(token)) throw notFound();
    const proposal = await Proposal.findOne({
        where: { tokenHash: hashToken(token) },
        include: [{ model: QuoteVersion, as: "quoteVersion" }, { model: User, as: "sentBy", attributes: ["id", "name", "email", "phone"] }],
    });
    if (!proposal) throw notFound();
    const opportunity = await Opportunity.findByPk(proposal.opportunityId);
    if (!opportunity) throw notFound();
    return { proposal, opportunity };
};

/** What the customer's page shows, and whether they can still answer. */
const publicState = (proposal) => {
    if (OPEN_STATUSES.includes(proposal.status)) return isExpired(proposal) ? "expired" : "open";
    return proposal.status; // accepted | rejected | negotiation | withdrawn
};

/**
 * Only this proposal: the business sending it, the snapshot the PDF is drawn
 * from (the customer's own quote), and their answer if they gave one. Nothing
 * else about the job — no notes, no margins, no other people.
 */
const presentPublic = async (proposal, opportunity) => {
    const unit = await BusinessUnit.findByPk(opportunity.businessUnitId);
    return {
        state: publicState(proposal),
        number: proposal.number,
        version: proposal.version,
        sentAt: proposal.issuedAt,
        expiresAt: proposal.expiresAt,
        grandTotal: proposal.grandTotal === null ? null : Number(proposal.grandTotal),
        customerName: customerFirstName(opportunity),
        business: { name: unit?.name ?? null, legalName: unit?.legalName ?? null },
        contact: proposal.sentBy ? { name: proposal.sentBy.name, email: proposal.sentBy.email, phone: proposal.sentBy.phone ?? null } : null,
        message: proposal.emailMessage,
        quoteVersion: proposal.quoteVersion
            ? { version: proposal.quoteVersion.version, snapshot: proposal.quoteVersion.snapshot, createdAt: proposal.quoteVersion.createdAt }
            : null,
        response: proposal.response
            ? { decision: proposal.response, at: proposal.respondedAt, name: proposal.responseName, note: proposal.responseNote }
            : null,
    };
};

/** Opening the link. The first open tells the salesperson; every open is counted. */
export const getPublicProposal = async (token) => {
    const { proposal, opportunity } = await loadByToken(token);

    if (publicState(proposal) === "open") {
        const firstView = !proposal.viewedAt;
        await proposal.update({
            viewCount: proposal.viewCount + 1,
            ...(firstView ? { viewedAt: new Date(), status: "presented", presentedAt: new Date() } : {}),
        });
        if (firstView) {
            await recordSystemEvent(opportunity, `The customer opened proposal ${proposal.number}.`, null);
            await notify({
                event: "proposal.viewed",
                title: `${opportunity.number}: customer opened the proposal`,
                body: `${customerLabel(opportunity)} opened ${proposal.number}.`,
                userIds: recipientsFor(opportunity, proposal),
                opportunity,
                dedupeKey: `proposal-viewed:${proposal.id}`,
            });
        }
    }
    return presentPublic(proposal, opportunity);
};

/**
 * { decision: accept | reject | renegotiate, name, note?, agree? }
 * Accepting needs the customer's name and their agreement to the terms;
 * renegotiating needs a note saying what to change.
 */
export const respondToProposal = async (token, payload = {}, { ip } = {}) => {
    const { proposal, opportunity } = await loadByToken(token);
    const state = publicState(proposal);
    if (state === "expired") throw httpError(410, "This proposal has expired. Please contact us for an updated one.");
    if (state !== "open") throw httpError(409, "This proposal has already been answered.");

    const decision = DECISIONS[String(payload.decision ?? "")];
    if (!decision) throw httpError(400, "Choose accept, renegotiate or decline");
    const name = oneLine(payload.name, 120);
    const note = multiLine(payload.note, 2000);
    if (!name) throw httpError(400, "Enter your full name");
    if (decision === "accepted" && payload.agree !== true) throw httpError(400, "Tick the box to agree to the proposal and its terms");
    if (decision === "renegotiate" && !note) throw httpError(400, "Tell us what you would like changed");

    await applyResponse(opportunity, proposal, { decision, name, note, channel: "customer", ip: ip ? String(ip).slice(0, 64) : null });
    const fresh = await loadByToken(token);
    return presentPublic(fresh.proposal, fresh.opportunity);
};
