import * as proposals from "../service/energyProposalService.js";
import asyncHandler from "../../../utils/asyncHandler.js";
import { successResponse } from "../../../utils/apiResponse.js";

export const options = asyncHandler(async (req, res) => {
    successResponse(res, { data: await proposals.proposalOptions(req.params.id) });
});

export const calculate = asyncHandler(async (req, res) => {
    successResponse(res, { data: await proposals.previewCalculation(req.params.id, req.body) });
});

export const list = asyncHandler(async (req, res) => {
    successResponse(res, { data: await proposals.listProposals(req.params.id) });
});

export const get = asyncHandler(async (req, res) => {
    successResponse(res, { data: await proposals.getProposal(req.params.id, req.params.proposalId) });
});

export const create = asyncHandler(async (req, res) => {
    successResponse(res, { data: await proposals.createProposal(req.params.id, req.body, req.user, req.activity) }, 201);
});

export const aiDraft = asyncHandler(async (req, res) => {
    successResponse(res, { data: await proposals.draftWithAi(req.params.id, req.body, req.user, req.activity) }, 201);
});

export const update = asyncHandler(async (req, res) => {
    successResponse(res, { data: await proposals.updateProposal(req.params.id, req.params.proposalId, req.body, req.user, req.activity) });
});

export const rewrite = asyncHandler(async (req, res) => {
    successResponse(res, { data: await proposals.rewriteNarrative(req.params.id, req.params.proposalId, req.body, req.user, req.activity) });
});

export const finalise = asyncHandler(async (req, res) => {
    successResponse(res, { data: await proposals.finaliseProposal(req.params.id, req.params.proposalId, req.user, req.activity) });
});

export const revise = asyncHandler(async (req, res) => {
    successResponse(res, { data: await proposals.reviseProposal(req.params.id, req.params.proposalId, req.user, req.activity) }, 201);
});

export const attachPdf = asyncHandler(async (req, res) => {
    successResponse(res, { data: await proposals.attachPdf(req.params.id, req.params.proposalId, req.file, req.user, req.activity) });
});

export const remove = asyncHandler(async (req, res) => {
    await proposals.deleteProposal(req.params.id, req.params.proposalId, req.user, req.activity);

    successResponse(res, { message: "Proposal deleted" });
});
