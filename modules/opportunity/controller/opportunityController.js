import {
    listOpportunities,
    getOpportunity,
    createLead,
    updateLead,
    advanceStage,
    deleteLead,
} from "../service/opportunityService.js";
import asyncHandler from "../../../utils/asyncHandler.js";

export const getAll = asyncHandler(async (req, res) => {
    const { rows, total, page, pageSize } = await listOpportunities(req.query);

    res.status(200).json({ success: true, data: rows, total, page, pageSize });
});

export const getOne = asyncHandler(async (req, res) => {
    const opportunity = await getOpportunity(req.params.id);

    res.status(200).json({ success: true, data: opportunity });
});

export const create = asyncHandler(async (req, res) => {
    const opportunity = await createLead(req.body, req.user);

    res.status(201).json({ success: true, data: opportunity });
});

export const update = asyncHandler(async (req, res) => {
    const opportunity = await updateLead(req.params.id, req.body, req.user);

    res.status(200).json({ success: true, data: opportunity });
});

export const advance = asyncHandler(async (req, res) => {
    const opportunity = await advanceStage(req.params.id, req.user);

    res.status(200).json({ success: true, data: opportunity });
});

export const remove = asyncHandler(async (req, res) => {
    await deleteLead(req.params.id, req.user);

    res.status(200).json({ success: true, message: "Lead deleted successfully" });
});
