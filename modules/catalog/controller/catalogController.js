import {
    listCatalogItems,
    listAllCatalogItems,
    createCatalogItem,
    updateCatalogItem,
    deleteCatalogItem,
} from "../service/catalogService.js";
import asyncHandler from "../../../utils/asyncHandler.js";
import { successResponse } from "../../../utils/apiResponse.js";

export const getAll = asyncHandler(async (req, res) => {
    const items = await listCatalogItems();

    successResponse(res, { data: items });
});

export const getManaged = asyncHandler(async (req, res) => {
    const items = await listAllCatalogItems();

    successResponse(res, { data: items });
});

export const create = asyncHandler(async (req, res) => {
    const item = await createCatalogItem(req.body);

    successResponse(res, { data: item }, 201);
});

export const update = asyncHandler(async (req, res) => {
    const item = await updateCatalogItem(req.params.id, req.body);

    successResponse(res, { data: item });
});

export const remove = asyncHandler(async (req, res) => {
    await deleteCatalogItem(req.params.id);

    successResponse(res, { message: "Catalog item deleted successfully" });
});
