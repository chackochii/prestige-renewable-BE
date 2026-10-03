// Approvals (stage 5): the board, one job's approvals, which approvals a
// job needs, and recording each one. Permissions are on the routes.

import * as approvals from "../service/approvalsService.js";
import asyncHandler from "../../../utils/asyncHandler.js";
import { successResponse } from "../../../utils/apiResponse.js";

export const board = asyncHandler(async (req, res) => {
    successResponse(res, { data: await approvals.approvalsBoard(req.query, req.user) });
});

export const list = asyncHandler(async (req, res) => {
    successResponse(res, { data: await approvals.listApprovals(req.params.id) });
});

/**
 * { keys } → the refreshed opportunity (requiredApprovals on it) — or, with
 * ?view=approvals, the job's approvals with the rows that followed the
 * change, so the approvals screens need no second request.
 */
export const setRequired = asyncHandler(async (req, res) => {
    const opportunity = await approvals.setRequiredApprovals(req.params.id, req.body, req.user);
    successResponse(res, { data: req.query.view === "approvals" ? await approvals.listApprovals(req.params.id) : opportunity });
});

export const update = asyncHandler(async (req, res) => {
    successResponse(res, { data: await approvals.updateApproval(req.params.id, req.params.type, req.body, req.user) });
});
