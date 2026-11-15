import { listActivity, activityFor } from "../service/activityService.js";
import asyncHandler from "../../../utils/asyncHandler.js";
import { successResponse } from "../../../utils/apiResponse.js";

export const getAll = asyncHandler(async (req, res) => {
    const result = await listActivity(req.query, req.user);

    successResponse(res, result);
});

export const getForEntity = asyncHandler(async (req, res) => {
    const rows = await activityFor(req.params.type, req.params.id);

    successResponse(res, { data: rows });
});
