import { createPublicLead } from "../service/publicLeadService.js";
import asyncHandler from "../../../utils/asyncHandler.js";

export const createFromPublicForm = asyncHandler(async (req, res) => {
    const result = await createPublicLead(req.body);
    res.status(201).json({ success: true, data: result });
});
