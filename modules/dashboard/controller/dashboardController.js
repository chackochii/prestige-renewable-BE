import { getDashboard, getTeamView } from "../service/dashboardService.js";
import asyncHandler from "../../../utils/asyncHandler.js";
import { successResponse } from "../../../utils/apiResponse.js";

export const dashboard = asyncHandler(async (req, res) => {
    successResponse(res, { data: await getDashboard(req.query, req.user) });
});

export const teamView = asyncHandler(async (req, res) => {
    successResponse(res, { data: await getTeamView(req.params.team, req.query, req.user) });
});
