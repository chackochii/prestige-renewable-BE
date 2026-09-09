import { Router } from "express";
import {
    getAll,
    getOne,
    create,
    update,
    advance,
    remove,
    createMeeting,
    deleteMeeting,
    getDocuments,
    createDocuments,
    deleteDocument,
    downloadDocument,
} from "../modules/opportunity/controller/opportunityController.js";
import tokenValidator from "../middleware/tokenValidator.js";
import tokenFromQuery from "../middleware/tokenFromQuery.js";
import requirePermission from "../middleware/requirePermission.js";
import uploadFiles from "../middleware/upload.js";

const router = Router();

// Guarded by the leads.* permissions from the RBAC catalog — who holds
// them is edited on the roles screen, not here.
router.get("/", tokenValidator, requirePermission("leads.read"), getAll); // ?businessUnitId=&stage=&lifecycle=&search=&page=&pageSize=
router.post("/", tokenValidator, requirePermission("leads.create"), create); // lead payload + businessUnitId
router.get("/:id", tokenValidator, requirePermission("leads.read"), getOne);
router.patch("/:id", tokenValidator, requirePermission("leads.update"), update); // lead fields, all optional
router.post("/:id/advance", tokenValidator, requirePermission("leads.update"), advance); // next enabled stage; gates apply
router.delete("/:id", tokenValidator, requirePermission("leads.delete"), remove); // stage-1 records only

// Lead pack attachments: the client-meeting log and uploaded documents.
router.post("/:id/meetings", tokenValidator, requirePermission("leads.update"), createMeeting); // { attendees, outcome?, nextStep?, at? }
router.delete("/:id/meetings/:meetingId", tokenValidator, requirePermission("leads.update"), deleteMeeting);
router.get("/:id/documents", tokenValidator, requirePermission("leads.read"), getDocuments);
router.post("/:id/documents", tokenValidator, requirePermission("leads.update"), uploadFiles, createDocuments); // multipart: files[] + type, stage?, label?
router.delete("/:id/documents/:docId", tokenValidator, requirePermission("leads.update"), deleteDocument);
// The file itself. Accepts ?token= so <img> tags and links can load it.
router.get("/:id/documents/:docId/file", tokenFromQuery, tokenValidator, requirePermission("leads.read"), downloadDocument);

export default router;
