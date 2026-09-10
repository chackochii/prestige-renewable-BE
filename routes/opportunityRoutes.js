import { Router } from "express";
import {
    getAll,
    getOne,
    create,
    update,
    advance,
    remove,
    getHistory,
    createHistoryEntry,
    getMeetings,
    createMeeting,
    deleteMeeting,
    getAttachments,
    createAttachment,
    getDocuments,
    createDocuments,
    deleteDocument,
    downloadDocument,
    setSalesperson,
    setEstimator,
    setCoordinator,
    notifyOwner,
} from "../modules/opportunity/controller/opportunityController.js";
import tokenValidator from "../middleware/tokenValidator.js";
import tokenFromQuery from "../middleware/tokenFromQuery.js";
import requirePermission from "../middleware/requirePermission.js";
import { uploadFiles, uploadSingleFile } from "../middleware/upload.js";

const router = Router();

// Every opportunity route needs a signed-in user; the file route also accepts
// a download-scoped token in the query string (see tokenFromQuery).
router.get("/:id/documents/:docId/file", tokenFromQuery, tokenValidator, requirePermission("leads.read"), downloadDocument);
router.use(tokenValidator);

// Guarded by the leads.* permissions from the RBAC catalog — who holds
// them is edited on the roles screen, not here.
const read = requirePermission("leads.read");
const write = requirePermission("leads.update");

router.get("/", read, getAll); // ?businessUnitId=&stage=&lifecycle=&search=&page=&pageSize=
router.post("/", requirePermission("leads.create"), create); // lead payload + businessUnitId
router.get("/:id", read, getOne);
router.patch("/:id", write, update); // lead fields, all optional
router.post("/:id/advance", write, advance); // next enabled stage; gates apply
router.delete("/:id", requirePermission("leads.delete"), remove); // stage-1 records only

// Job history: notes people add plus system events (assignments, notifications).
router.get("/:id/history", read, getHistory);
router.post("/:id/history", write, createHistoryEntry); // { note }

// Client meeting / site visit log (kept on the record).
router.get("/:id/meetings", read, getMeetings);
router.post("/:id/meetings", write, createMeeting); // { attendees, outcome?, nextStep?, at? } → the entry
router.delete("/:id/meetings/:meetingId", write, deleteMeeting);

// Attachments as the lead screens see them: one file per request with a
// category (photo | sketch | bill | document); each comes back with a URL the
// browser can open directly.
router.get("/:id/attachments", read, getAttachments);
router.post("/:id/attachments", write, uploadSingleFile, createAttachment); // multipart: file + category

// Generic documents (type, stage, label) for every pipeline stage.
router.get("/:id/documents", read, getDocuments);
router.post("/:id/documents", write, uploadFiles, createDocuments); // multipart: files[] + type, stage?, label?
router.delete("/:id/documents/:docId", write, deleteDocument);

// Role assignments — discrete, audited actions (each writes a history entry).
router.post("/:id/assign-salesperson", write, setSalesperson); // { salespersonId | null, reason? }
router.post("/:id/assign-estimator", write, setEstimator); // { estimatorId }
router.post("/:id/assign-coordinator", write, setCoordinator); // { operationalCoordinatorId }
// In-app notification to the unit's Business Owner(s) about this lead.
router.post("/:id/notify-owner", write, notifyOwner);

export default router;
