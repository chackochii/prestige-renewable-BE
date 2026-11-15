import * as payments from "../service/customerPaymentService.js";
import asyncHandler from "../../../utils/asyncHandler.js";
import { successResponse } from "../../../utils/apiResponse.js";

export const getAll = asyncHandler(async (req, res) => {
    successResponse(res, await payments.listPayments(req.query, req.user));
});

export const getOne = asyncHandler(async (req, res) => {
    successResponse(res, { data: await payments.getPayment(req.params.id, req.user) });
});

export const create = asyncHandler(async (req, res) => {
    successResponse(res, { data: await payments.createPayment(req.body, req.user, req.activity) }, 201);
});

export const update = asyncHandler(async (req, res) => {
    successResponse(res, { data: await payments.updatePayment(req.params.id, req.body, req.user, req.activity) });
});

export const addReceipt = asyncHandler(async (req, res) => {
    successResponse(res, { data: await payments.addReceipt(req.params.id, req.body, req.user, req.activity) }, 201);
});

export const removeReceipt = asyncHandler(async (req, res) => {
    successResponse(res, { data: await payments.removeReceipt(req.params.id, req.params.receiptId, req.user, req.activity) });
});

export const remove = asyncHandler(async (req, res) => {
    await payments.deletePayment(req.params.id, req.user, req.activity);

    successResponse(res, { message: "Customer payment deleted" });
});
