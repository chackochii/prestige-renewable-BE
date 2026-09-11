import { listCatalogItems } from "../service/catalogService.js";
import asyncHandler from "../../../utils/asyncHandler.js";

export const getAll = asyncHandler(async (req, res) => {
    const items = await listCatalogItems();

    res.status(200).json({ success: true, data: items });
});
