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
    notifySales,
    notifyOpsCoordinator,
    estimationRequirements,
    estimationClientInfo,
    estimationChecklist,
    getQuote,
    createQuote,
    updateQuote,
    addQuoteItem,
    updateQuoteItem,
    deleteQuoteItem,
    addQuoteCost,
    updateQuoteCost,
    deleteQuoteCost,
} from "../modules/opportunity/controller/opportunityController.js";
import tokenValidator from "../middleware/tokenValidator.js";
import tokenFromQuery from "../middleware/tokenFromQuery.js";
import requirePermission, { requireAnyPermission } from "../middleware/requirePermission.js";
import { uploadFiles, uploadSingleFile } from "../middleware/upload.js";

const router = Router();

// Guarded by the leads.* / estimation.* permissions from the RBAC catalog —
// who holds them is edited on the roles screen, not here.
const read = requirePermission("leads.read");
const write = requirePermission("leads.update");
const estimate = requirePermission("estimation.update"); // stage-2 work; independent of leads.update
const readAny = requireAnyPermission("leads.read", "estimation.read");

// Every opportunity route needs a signed-in user; the file route also accepts
// a download-scoped token in the query string (see tokenFromQuery). It uses
// the same readAny guard as the attachment/document lists that hand out its
// URLs, so anyone who can see a link can also open it.
router.get("/:id/documents/:docId/file", tokenFromQuery, tokenValidator, readAny, downloadDocument);
router.use(tokenValidator);

router.get("/", read, getAll); // ?businessUnitId=&stage=&lifecycle=&search=&page=&pageSize=
router.post("/", requirePermission("leads.create"), create); // lead payload + businessUnitId
router.get("/:id", readAny, getOne);
router.patch("/:id", write, update); // lead fields, all optional
router.post("/:id/advance", requireAnyPermission("leads.update", "estimation.update"), advance); // next enabled stage; gates apply
router.delete("/:id", requirePermission("leads.delete"), remove); // stage-1 records only

// Job history: notes people add plus system events (assignments, notifications).
router.get("/:id/history", readAny, getHistory);
router.post("/:id/history", requireAnyPermission("leads.update", "estimation.update"), createHistoryEntry); // { note }

// Client meeting / site visit log (kept on the record).
router.get("/:id/meetings", readAny, getMeetings);
router.post("/:id/meetings", write, createMeeting); // { attendees, outcome?, nextStep?, at? } → the entry
router.delete("/:id/meetings/:meetingId", write, deleteMeeting);

// Attachments as the lead/estimation screens see them: one file per request
// with a category (photo | sketch | bill | document | client_document); each
// comes back with a URL the browser can open directly.
router.get("/:id/attachments", readAny, getAttachments);
router.post("/:id/attachments", requireAnyPermission("leads.update", "estimation.update"), uploadSingleFile, createAttachment); // multipart: file + category

// Generic documents (type, stage, label) for every pipeline stage.
router.get("/:id/documents", readAny, getDocuments);
router.post("/:id/documents", requireAnyPermission("leads.update", "estimation.update"), uploadFiles, createDocuments); // multipart: files[] + type, stage?, label?
router.delete("/:id/documents/:docId", requireAnyPermission("leads.update", "estimation.update"), deleteDocument);

// Role assignments — discrete, audited actions (each writes a history entry).
router.post("/:id/assign-salesperson", write, setSalesperson); // { salespersonId | null, reason? }
router.post("/:id/assign-estimator", write, setEstimator); // { estimatorId }
// Shared by the lead pack and the estimation screen.
router.post("/:id/assign-coordinator", requireAnyPermission("leads.update", "estimation.update"), setCoordinator); // { operationalCoordinatorId }
// In-app notifications.
router.post("/:id/notify-owner", write, notifyOwner); // Business Owner(s): new lead
router.post("/:id/notify-sales-manager", estimate, notifySales); // Sales manager + salesperson: estimation on hold
router.post("/:id/notify-operations-coordinator", estimate, notifyOpsCoordinator); // Ops coordinator: site visit needed

// Estimation workflow (stage 2) — each returns the refreshed opportunity.
router.post("/:id/estimation/requirements", estimate, estimationRequirements); // { received, checklistKeys?, reason? }
router.post("/:id/estimation/client-info", estimate, estimationClientInfo); // { needed }
router.post("/:id/estimation/checklist", estimate, estimationChecklist); // { checklistValues, preSiteInspectionRequired, siteVisitAssigneeId?, siteVisitCompleted? }

// Quote builder — one quote per opportunity, nested items and costs.
router.get("/:id/quote", readAny, getQuote); // → quote or null
router.post("/:id/quote", estimate, createQuote); // → quote (idempotent)
router.patch("/:id/quote", estimate, updateQuote); // { project?, projectType?, projectTypeOther?, quoteDate?, taxTreatment?, gstRatePct? }
router.post("/:id/quote/items", estimate, addQuoteItem); // { itemKey, itemName, brand, unit, quantity, unitPrice, discountPct } → item
router.patch("/:id/quote/items/:itemId", estimate, updateQuoteItem); // → item
router.delete("/:id/quote/items/:itemId", estimate, deleteQuoteItem);
router.post("/:id/quote/costs", estimate, addQuoteCost); // { costType, calcType, value, description } → cost
router.patch("/:id/quote/costs/:costId", estimate, updateQuoteCost); // → cost
router.delete("/:id/quote/costs/:costId", estimate, deleteQuoteCost);

export default router;
