// Proposals: sales sending them (signed in) and the customer answering one
// through the link in their email (no sign-in — the token is the authority;
// proposalService decides what it opens).

import * as proposals from "../service/proposalService.js";
import asyncHandler from "../../../utils/asyncHandler.js";
import { successResponse } from "../../../utils/apiResponse.js";

/**
 * The app the sender is using, as the fallback base for the customer's link
 * when FRONTEND_URL is not set. Only an http(s) origin is taken.
 */
const linkBase = (req) => {
    const origin = req.get("origin") || "";
    return /^https?:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(origin) ? origin : null;
};

// ---- Staff ----

export const board = asyncHandler(async (req, res) => {
    successResponse(res, { data: await proposals.proposalBoard(req.query, req.user) });
});

export const list = asyncHandler(async (req, res) => {
    successResponse(res, { data: await proposals.listProposals(req.params.id) });
});

export const send = asyncHandler(async (req, res) => {
    const data = await proposals.sendProposal(req.params.id, req.body, req.user, { linkBase: linkBase(req) });
    successResponse(res, { data }, 201);
});

export const resend = asyncHandler(async (req, res) => {
    const data = await proposals.resendProposal(req.params.id, req.params.proposalId, req.body, req.user, { linkBase: linkBase(req) });
    successResponse(res, { data });
});

export const outcome = asyncHandler(async (req, res) => {
    successResponse(res, { data: await proposals.recordOutcome(req.params.id, req.params.proposalId, req.body, req.user) });
});

// ---- Public ----

// The page carries the customer's proposal; nothing in between should keep it.
const noStore = (res) => res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });

export const getPublic = asyncHandler(async (req, res) => {
    noStore(res);
    successResponse(res, { data: await proposals.getPublicProposal(req.params.token) });
});

export const respondPublic = asyncHandler(async (req, res) => {
    noStore(res);
    successResponse(res, { data: await proposals.respondToProposal(req.params.token, req.body, { ip: req.ip }) });
});
