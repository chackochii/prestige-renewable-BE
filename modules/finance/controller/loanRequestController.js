import * as loans from "../service/loanRequestService.js";
import asyncHandler from "../../../utils/asyncHandler.js";
import { successResponse } from "../../../utils/apiResponse.js";

export const getAll = asyncHandler(async (req, res) => {
    successResponse(res, await loans.listLoanRequests(req.query, req.user));
});

export const getOne = asyncHandler(async (req, res) => {
    successResponse(res, { data: await loans.getLoanRequest(req.params.id, req.user) });
});

export const create = asyncHandler(async (req, res) => {
    successResponse(res, { data: await loans.createLoanRequest(req.body, req.user, req.activity) }, 201);
});

export const update = asyncHandler(async (req, res) => {
    successResponse(res, { data: await loans.updateLoanRequest(req.params.id, req.body, req.user, req.activity) });
});

export const review = asyncHandler(async (req, res) => {
    successResponse(res, { data: await loans.reviewLoanRequest(req.params.id, req.body, req.user, req.activity) });
});

export const reply = asyncHandler(async (req, res) => {
    successResponse(res, { data: await loans.replyOnLoanRequest(req.params.id, req.body, req.user, req.activity) }, 201);
});

export const attach = asyncHandler(async (req, res) => {
    successResponse(res, { data: await loans.attachToLoanRequest(req.params.id, req.file, req.body, req.user, req.activity) }, 201);
});

export const remove = asyncHandler(async (req, res) => {
    await loans.deleteLoanRequest(req.params.id, req.body ?? {}, req.user, req.activity);

    successResponse(res, { message: "Loan request deleted" });
});
