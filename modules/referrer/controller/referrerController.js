import { listReferrers } from "../service/referrerService.js";
import asyncHandler from "../../../utils/asyncHandler.js";

export const getAll = asyncHandler(async (req, res) => {
    const referrers = await listReferrers(req.query);

    res.status(200).json({ success: true, data: referrers });
});
