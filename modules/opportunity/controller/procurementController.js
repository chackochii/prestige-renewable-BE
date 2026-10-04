// Procurement & delivery (stage 6): the board, one job's record, the BOQ and
// its rounds, supplier quotes, purchase orders, the price-variation approvals
// and the coordinator's checklists. Permissions are on the routes; who may
// approve a variation is decided in the service from the actor's roles.

import * as procurement from "../service/procurementService.js";
import asyncHandler from "../../../utils/asyncHandler.js";
import { successResponse } from "../../../utils/apiResponse.js";

// ?businessUnitId=&search=&page=&pageSize= → { data, total, page, pageSize, counts }
export const board = asyncHandler(async (req, res) => {
    const { rows, total, page, pageSize, counts } = await procurement.procurementBoard(req.query, req.user);
    successResponse(res, { data: rows, total, page, pageSize, counts });
});

export const getOne = asyncHandler(async (req, res) => {
    successResponse(res, { data: await procurement.getProcurementJob(req.params.id, req.user) });
});

export const checklist = asyncHandler(async (req, res) => {
    successResponse(res, { data: await procurement.updateChecklist(req.params.id, req.params.section, req.body, req.user) });
});

export const boq = asyncHandler(async (req, res) => {
    successResponse(res, { data: await procurement.updateBoq(req.params.id, req.body, req.user) });
});

export const addQuote = asyncHandler(async (req, res) => {
    successResponse(res, { data: await procurement.addQuote(req.params.id, req.body, req.user) }, 201);
});

export const removeQuote = asyncHandler(async (req, res) => {
    successResponse(res, { data: await procurement.removeQuote(req.params.id, req.params.index, req.user) });
});

export const createPurchaseOrder = asyncHandler(async (req, res) => {
    successResponse(res, { data: await procurement.createPurchaseOrder(req.params.id, req.body, req.user) }, 201);
});

export const updatePurchaseOrder = asyncHandler(async (req, res) => {
    successResponse(res, { data: await procurement.updatePurchaseOrder(req.params.id, req.params.poId, req.body, req.user) });
});

export const deletePurchaseOrder = asyncHandler(async (req, res) => {
    successResponse(res, { data: await procurement.deletePurchaseOrder(req.params.id, req.params.poId, req.user) });
});

export const decideVariation = asyncHandler(async (req, res) => {
    successResponse(res, { data: await procurement.decideVariation(req.params.id, req.params.role, req.body, req.user) });
});
