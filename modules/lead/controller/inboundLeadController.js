import asyncHandler from "../../../utils/asyncHandler.js";
import { successResponse } from "../../../utils/apiResponse.js";
import {
    convertInboundLead,
    getInboundLead,
    listInboundLeads,
    refreshInboundLead,
    rejectInboundLead,
    reopenInboundLead,
} from "../service/inboundLeadService.js";

export const list = asyncHandler(async (req, res) => {
    const { rows, total, page, pageSize, counts } = await listInboundLeads(req.query);
    successResponse(res, { data: rows, total, page, pageSize, counts });
});

export const getOne = asyncHandler(async (req, res) => {
    successResponse(res, { data: await getInboundLead(req.params.id, req.user) });
});

export const convert = asyncHandler(async (req, res) => {
    successResponse(res, { data: await convertInboundLead(req.params.id, req.body, req.user) }, 201);
});

export const reject = asyncHandler(async (req, res) => {
    successResponse(res, { data: await rejectInboundLead(req.params.id, req.body, req.user) });
});

export const reopen = asyncHandler(async (req, res) => {
    successResponse(res, { data: await reopenInboundLead(req.params.id, req.user) });
});

export const refresh = asyncHandler(async (req, res) => {
    successResponse(res, { data: await refreshInboundLead(req.params.id, req.user) });
});
