import { listCatalogItems } from "../service/catalogService.js";
import asyncHandler from "../../../utils/asyncHandler.js";
import { successResponse } from "../../../utils/apiResponse.js";

export const getAll = asyncHandler(async (req, res) => {
    const items = await listCatalogItems();

    successResponse(res, { data: items });
});
