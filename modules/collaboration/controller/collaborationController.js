import { pipeline } from "node:stream/promises";
import * as service from "../service/collaborationService.js";
import asyncHandler from "../../../utils/asyncHandler.js";
import { successResponse, errorResponse } from "../../../utils/apiResponse.js";
import { INLINE_MIME } from "../../opportunity/service/leadAttachmentService.js";

export const getAll = asyncHandler(async (req, res) => {
    const { rows, total, page, pageSize } = await service.listRequests(req.user, req.query);

    successResponse(res, { data: rows, total, page, pageSize });
});

export const getOne = asyncHandler(async (req, res) => {
    successResponse(res, { data: await service.getRequest(req.user, req.params.id) });
});

export const getHistory = asyncHandler(async (req, res) => {
    successResponse(res, { data: await service.listHistory(req.user, req.params.id) });
});

// ---- Raised against one opportunity -----------------------------------------

export const getForOpportunity = asyncHandler(async (req, res) => {
    successResponse(res, { data: await service.listForOpportunity(req.user, req.params.id) });
});

export const create = asyncHandler(async (req, res) => {
    const request = await service.createRequest(req.user, req.params.id, req.body);

    successResponse(res, { data: request }, 201);
});

// ---- The request's own lifecycle --------------------------------------------

export const update = asyncHandler(async (req, res) => {
    successResponse(res, { data: await service.updateRequest(req.user, req.params.id, req.body) });
});

export const cancel = asyncHandler(async (req, res) => {
    successResponse(res, { data: await service.cancelRequest(req.user, req.params.id, req.body) });
});

export const respond = asyncHandler(async (req, res) => {
    successResponse(res, { data: await service.submitResponse(req.user, req.params.id, req.body) });
});

export const decide = asyncHandler(async (req, res) => {
    successResponse(res, { data: await service.decideResponse(req.user, req.params.id, req.body) });
});

export const progress = asyncHandler(async (req, res) => {
    successResponse(res, { data: await service.addProgress(req.user, req.params.id, req.body) });
});

// ---- Files -------------------------------------------------------------------

export const addAttachment = asyncHandler(async (req, res) => {
    const result = await service.addRequestAttachment(
        req.user,
        req.params.id,
        req.body?.category,
        req.file,
        req.body?.documentKey
    );

    successResponse(res, { data: result }, 201);
});

export const fileOnJob = asyncHandler(async (req, res) => {
    successResponse(res, { data: await service.fileAttachmentOnOpportunity(req.user, req.params.id, req.body) });
});

export const downloadAttachment = asyncHandler(async (req, res) => {
    // A download-scoped token opens one collaboration attachment and nothing else.
    const scoped = req.tokenPayload?.scope === "download";
    if (scoped && (Number(req.tokenPayload.doc) !== Number(req.params.attachmentId) || req.tokenPayload.kind !== "collaboration"))
        return errorResponse(res, "This link is for a different file", 403);

    const { attachment, file } = await service.getAttachmentFile(req.user, req.params.id, req.params.attachmentId);
    const mime = attachment.mime || "application/octet-stream";
    const inline = INLINE_MIME.test(mime) && req.query.download !== "1";

    res.set({
        "Content-Type": mime,
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
        "Cache-Control": "private, max-age=3600",
        ...(file.size !== undefined ? { "Content-Length": String(file.size) } : {}),
    });
    try {
        await pipeline(file.body, res);
    } catch (err) {
        if (err.code !== "ERR_STREAM_PREMATURE_CLOSE") throw err;
    }
    return undefined;
});
