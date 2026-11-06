import { createPublicLead, publicLeadBrand } from "../service/publicLeadService.js";
import asyncHandler from "../../../utils/asyncHandler.js";
import { successResponse } from "../../../utils/apiResponse.js";

export const createFromPublicForm = asyncHandler(async (req, res) => {
    const result = await createPublicLead(req.body);
    successResponse(res, { data: result }, 201);
});

/** ?unit=PRS (the code on the link, optional) → { businessUnit, brand } */
export const getPublicFormBrand = asyncHandler(async (req, res) => {
    successResponse(res, { data: await publicLeadBrand(req.query.unit) });
});
