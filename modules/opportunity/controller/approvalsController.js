// Approvals (stage 5): the board, one job's approvals, which approvals a
// job needs, and recording each one. Permissions are on the routes.

import * as approvals from "../service/approvalsService.js";
import asyncHandler from "../../../utils/asyncHandler.js";
import { successResponse } from "../../../utils/apiResponse.js";

// ?businessUnitId=&search=&page=&pageSize= → { data, total, page, pageSize, counts }
export const board = asyncHandler(async (req, res) => {
    const { rows, total, page, pageSize, counts } = await approvals.approvalsBoard(req.query, req.user);
    successResponse(res, { data: rows, total, page, pageSize, counts });
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

// The way out of approvals and back (UAT exit logic). Each answers with the job's approvals.

/** { note?, files?: [{ id, filename, url }] } — a document or note on an approval, its status untouched. */
export const addAddendum = asyncHandler(async (req, res) => {
    successResponse(res, { data: await approvals.addApprovalAddendum(req.params.id, req.params.type, req.body, req.user) });
});

/** { option, reason, newKey?, newLabel?, lostReason?, changes? } — a rejected approval resolved. */
export const resolve = asyncHandler(async (req, res) => {
    successResponse(res, { data: await approvals.resolveRejection(req.params.id, req.params.type, req.body, req.user) });
});

/** { reason } — back to stage 5 from procurement or construction. */
export const reopen = asyncHandler(async (req, res) => {
    successResponse(res, { data: await approvals.reopenApprovals(req.params.id, req.body, req.user) });
});

/** { reason } — On Hold; it cannot be sent to Procurement until resumed. */
export const hold = asyncHandler(async (req, res) => {
    successResponse(res, { data: await approvals.holdApprovals(req.params.id, req.body, req.user) });
});

export const resume = asyncHandler(async (req, res) => {
    successResponse(res, { data: await approvals.resumeApprovals(req.params.id, req.user) });
});

/** { note? } — Approval Review Needed cleared. */
export const review = asyncHandler(async (req, res) => {
    successResponse(res, { data: await approvals.markApprovalsReviewed(req.params.id, req.body, req.user) });
});
