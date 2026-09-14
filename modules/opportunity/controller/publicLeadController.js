import { createPublicLead } from "../service/publicLeadService.js";
import asyncHandler from "../../../utils/asyncHandler.js";
import { successResponse } from "../../../utils/apiResponse.js";

export const createFromPublicForm = asyncHandler(async (req, res) => {
    const result = await createPublicLead(req.body);
    successResponse(res, { data: result }, 201);
});
