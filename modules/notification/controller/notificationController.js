import {
    listNotifications,
    markAllRead,
    setRead,
    unreadCount,
} from "../service/notificationService.js";
import { eventCatalogue } from "../service/notificationEvents.js";
import { subscribe } from "../service/notificationStream.js";
import asyncHandler from "../../../utils/asyncHandler.js";
import { successResponse } from "../../../utils/apiResponse.js";
import { signStreamToken } from "../../../utils/jwt.js";

export const getAll = asyncHandler(async (req, res) => {
    const { rows, total, page, pageSize, unread } = await listNotifications(req.user, req.query);

    successResponse(res, { data: rows, total, page, pageSize, unread });
});

export const getUnreadCount = asyncHandler(async (req, res) => {
    successResponse(res, { data: { unread: await unreadCount(req.user.id) } });
});

export const read = asyncHandler(async (req, res) => {
    const notification = await setRead(req.user, req.params.id, req.body?.read !== false);

    successResponse(res, { data: notification });
});

export const readAll = asyncHandler(async (req, res) => {
    successResponse(res, { data: await markAllRead(req.user) });
});

export const getEvents = asyncHandler(async (req, res) => {
    successResponse(res, { data: eventCatalogue() });
});

/**
 * A short-lived token for the stream below. EventSource cannot send an
 * Authorization header, so the browser asks for this over the normal
 * authenticated API and puts it in the stream URL — the session token itself
 * never appears in a URL (same approach as document download links).
 */
export const streamToken = asyncHandler(async (req, res) => {
    successResponse(res, { data: { token: signStreamToken(req.user) } });
});

/**
 * Server-Sent Events: stays open and writes a "notification" event whenever
 * one is raised for this user. The browser's EventSource reconnects on its
 * own, so nothing here retries.
 */
export const stream = asyncHandler(async (req, res) => {
    res.status(200).set({
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        // Nginx and friends buffer responses by default, which would hold
        // events back until the buffer fills.
        "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();
    // How long the browser waits before reconnecting.
    res.write("retry: 5000\n\n");

    const unsubscribe = subscribe(req.user.id, res);
    res.write(`event: ready\ndata: ${JSON.stringify({ unread: await unreadCount(req.user.id) })}\n\n`);

    req.on("close", () => {
        unsubscribe();
        res.end();
    });
});
