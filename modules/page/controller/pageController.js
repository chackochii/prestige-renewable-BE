import {
    listPages,
    createPage,
    updatePage,
    deletePage,
    getUnitPages,
    setUnitPages,
} from "../service/pageService.js";
import asyncHandler from "../../../utils/asyncHandler.js";

export const getAll = asyncHandler(async (req, res) => {
    const pages = await listPages();

    res.status(200).json({ success: true, data: pages });
});

export const create = asyncHandler(async (req, res) => {
    const page = await createPage(req.body);

    res.status(201).json({ success: true, data: page });
});

export const update = asyncHandler(async (req, res) => {
    const page = await updatePage(req.params.code, req.body);

    res.status(200).json({ success: true, data: page });
});

export const remove = asyncHandler(async (req, res) => {
    await deletePage(req.params.code);

    res.status(200).json({ success: true, message: "Page deleted successfully" });
});

// Per-unit enablement, mounted under /business-units/:id/pages
export const getForUnit = asyncHandler(async (req, res) => {
    const data = await getUnitPages(req.params.id);

    res.status(200).json({ success: true, data });
});

export const setForUnit = asyncHandler(async (req, res) => {
    const data = await setUnitPages(req.params.id, req.body.pages, req.user);

    res.status(200).json({ success: true, data });
});
