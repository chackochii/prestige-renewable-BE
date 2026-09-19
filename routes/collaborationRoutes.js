import { Router } from "express";
import {
    addAttachment,
    cancel,
    decide,
    downloadAttachment,
    getAll,
    getHistory,
    getOne,
    fileOnJob,
    progress,
    respond,
    update,
} from "../modules/collaboration/controller/collaborationController.js";
import tokenValidator from "../middleware/tokenValidator.js";
import { tokenFromQuery } from "../middleware/tokenFromQuery.js";
import { requireAnyPermission } from "../middleware/requirePermission.js";
import { uploadSingleFile } from "../middleware/upload.js";

const router = Router();

// Working on a request needs the same grant as reading the record it hangs
// off — who may do what is then decided per request in the service: only the
// assignee responds or reports progress, only the requester edits, decides or
// cancels. It deliberately does not ask for leads.update: the teams this
// module exists to reach (operations, procurement) hold read on the record
// and would otherwise be unable to answer work handed to them.
const read = requireAnyPermission("leads.read", "estimation.read");
// Copying a supplied file into the job's own attachments does change the
// record, so it asks for the same grant as uploading one there directly.
const writeRecord = requireAnyPermission("leads.update", "estimation.update");

// Files are fetched by <img>/<a>, which cannot set a header, so this route also
// accepts a download-scoped token in the query string. Declared before the
// blanket tokenValidator so the query token is picked up first.
router.get(
    "/requests/:id/attachments/:attachmentId/file",
    tokenFromQuery("download"),
    tokenValidator,
    read,
    downloadAttachment
);

router.use(tokenValidator);

router.get("/requests", read, getAll); // ?businessUnitId=&scope=assigned|raised|all&kind=&department=&status=&overdue=&page=&pageSize=
router.get("/requests/:id", read, getOne);
router.get("/requests/:id/history", read, getHistory);

router.patch("/requests/:id", read, update); // requester: { title?, description?, priority?, dueAt?, assigneeId? }
router.post("/requests/:id/cancel", read, cancel); // requester: { reason }
router.post("/requests/:id/response", read, respond); // assignee: { fields, note?, draft? }
router.post("/requests/:id/decision", read, decide); // requester: { outcome, note? }
router.post("/requests/:id/progress", read, progress); // assignee: { status, note?, scheduledFor?, internal? }
router.post("/requests/:id/attachments", read, uploadSingleFile, addAttachment); // multipart: file + category + documentKey?
router.post("/requests/:id/attachments/file-on-job", writeRecord, fileOnJob); // { attachmentId, category }

export default router;
