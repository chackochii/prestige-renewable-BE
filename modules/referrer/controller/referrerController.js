import { listReferrers } from "../service/referrerService.js";
import asyncHandler from "../../../utils/asyncHandler.js";
import { successResponse } from "../../../utils/apiResponse.js";

export const getAll = asyncHandler(async (req, res) => {
    const referrers = await listReferrers(req.query);

    successResponse(res, { data: referrers });
});
