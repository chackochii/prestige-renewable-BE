// Lead management (assignment trail, reassignment, duplicate check, intake)
// and quote approval endpoints.
import { getOpportunity } from "../service/opportunityService.js";
import { reassignSalesperson } from "../service/leadWorkflowService.js";
import { findDuplicateLeads, listAssignments } from "../service/leadAssignmentService.js";
import { intakeLead } from "../service/leadIntakeService.js";
import * as quoteApprovals from "../service/quoteApprovalService.js";
import { assertUnitAccess } from "../../../utils/unitScope.js";
import { parseId } from "../../../utils/ids.js";
import asyncHandler from "../../../utils/asyncHandler.js";
import { successResponse } from "../../../utils/apiResponse.js";

// ---- Leads -----------------------------------------------------------------

export const intake = asyncHandler(async (req, res) => {
    const id = await intakeLead(req.body, req.user, req.activity);

    successResponse(res, { data: await getOpportunity(id) }, 201);
});

/** ?businessUnitId=&phone=&email=&excludeId= → the active leads that share either. */
export const duplicates = asyncHandler(async (req, res) => {
    const businessUnitId = parseId(req.query.businessUnitId, "businessUnitId");
    assertUnitAccess(req.user, businessUnitId);
    const matches = await findDuplicateLeads({
        businessUnitId,
        phone: req.query.phone,
        email: req.query.email,
        excludeId: req.query.excludeId ? parseId(req.query.excludeId, "excludeId") : null,
    });

    successResponse(res, { data: matches, duplicate: matches.length > 0 });
});

export const assignments = asyncHandler(async (req, res) => {
    successResponse(res, { data: await listAssignments(req.params.id) });
});

export const reassign = asyncHandler(async (req, res) => {
    await reassignSalesperson(req.params.id, req.body, req.user, req.activity);

    successResponse(res, { data: await getOpportunity(req.params.id) });
});

// ---- Quote approvals ---------------------------------------------------------

export const listQuoteApprovals = asyncHandler(async (req, res) => {
    successResponse(res, { data: await quoteApprovals.listForOpportunity(req.params.id) });
});

export const submitQuoteApproval = asyncHandler(async (req, res) => {
    successResponse(res, { data: await quoteApprovals.submitForApproval(req.params.id, req.body, req.user, req.activity) }, 201);
});

export const decideQuoteApproval = asyncHandler(async (req, res) => {
    successResponse(res, { data: await quoteApprovals.decideApproval(req.params.id, req.params.approvalId, req.body, req.user, req.activity) });
});

export const quoteApprovalQueue = asyncHandler(async (req, res) => {
    successResponse(res, await quoteApprovals.listQueue(req.query, req.user));
});
