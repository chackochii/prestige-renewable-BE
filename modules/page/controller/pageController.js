import {
    listPages,
    createPage,
    updatePage,
    deletePage,
    getUnitPages,
    setUnitPages,
} from "../service/pageService.js";
import asyncHandler from "../../../utils/asyncHandler.js";
import { successResponse } from "../../../utils/apiResponse.js";

export const getAll = asyncHandler(async (req, res) => {
    const pages = await listPages();

    successResponse(res, { data: pages });
});

export const create = asyncHandler(async (req, res) => {
    const page = await createPage(req.body);

    successResponse(res, { data: page }, 201);
});

export const update = asyncHandler(async (req, res) => {
    const page = await updatePage(req.params.code, req.body);

    successResponse(res, { data: page });
});

export const remove = asyncHandler(async (req, res) => {
    await deletePage(req.params.code);

    successResponse(res, { message: "Page deleted successfully" });
});

// Per-unit enablement, mounted under /business-units/:id/pages
export const getForUnit = asyncHandler(async (req, res) => {
    const data = await getUnitPages(req.params.id);

    successResponse(res, { data });
});

export const setForUnit = asyncHandler(async (req, res) => {
    const data = await setUnitPages(req.params.id, req.body.pages, req.user);

    successResponse(res, { data });
});
