// The public site-visit form. No sign-in: the token in the path is the whole of
// the caller's authority, and siteVisitService decides what it opens.

import { pipeline } from "node:stream/promises";
import * as siteVisits from "../service/siteVisitService.js";
import asyncHandler from "../../../utils/asyncHandler.js";
import { successResponse } from "../../../utils/apiResponse.js";
import { INLINE_MIME } from "../../opportunity/service/leadAttachmentService.js";

export const getTask = asyncHandler(async (req, res) => {
    successResponse(res, { data: await siteVisits.getPublicTask(req.params.token) });
});

export const submitTask = asyncHandler(async (req, res) => {
    successResponse(res, { data: await siteVisits.submitPublicTask(req.params.token, req.body) });
});

export const uploadPhoto = asyncHandler(async (req, res) => {
    const photo = await siteVisits.uploadPublicPhoto(req.params.token, req.file, req.body?.documentKey);
    successResponse(res, { data: photo }, 201);
});

export const downloadPhoto = asyncHandler(async (req, res) => {
    const { photo, file } = await siteVisits.getPublicPhoto(req.params.token, req.params.photoId);
    const mime = photo.mime || "application/octet-stream";
    const inline = INLINE_MIME.test(mime) && req.query.download !== "1";

    res.set({
        "Content-Type": mime,
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(photo.filename)}`,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
        // The link is not a secret the browser should share with a proxy.
        "Cache-Control": "private, max-age=3600",
        ...(file.size !== undefined ? { "Content-Length": String(file.size) } : {}),
    });
    try {
        await pipeline(file.body, res);
    } catch (err) {
        // The browser dropping the connection early (a cancelled image load) is not a server error.
        if (err.code !== "ERR_STREAM_PREMATURE_CLOSE") throw err;
    }
    return undefined;
});
