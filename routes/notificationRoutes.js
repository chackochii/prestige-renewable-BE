import { Router } from "express";
import {
    getAll,
    getEvents,
    getUnreadCount,
    read,
    readAll,
    stream,
    streamToken,
} from "../modules/notification/controller/notificationController.js";
import tokenValidator from "../middleware/tokenValidator.js";
import { tokenFromQuery } from "../middleware/tokenFromQuery.js";

const router = Router();

// The live stream authenticates with a short-lived "stream" token in the query
// string (EventSource cannot set headers); a normal session token in the header
// works too. Declared before the blanket tokenValidator below so the query
// token is picked up first.
router.get("/stream", tokenFromQuery("stream"), tokenValidator, stream);

router.use(tokenValidator);

// Everyone reads and manages their own notifications — no permission needed;
// the service scopes every query to req.user.
router.get("/", getAll); // ?unread=1&priority=high&event=&page=&pageSize=
router.get("/unread-count", getUnreadCount);
router.get("/events", getEvents); // the event catalogue + default priorities
router.post("/stream-token", streamToken);
router.post("/read-all", readAll);
router.patch("/:id/read", read); // { read?: boolean } — defaults to true

export default router;
