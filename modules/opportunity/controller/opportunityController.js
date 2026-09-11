import {
    listOpportunities,
    getOpportunity,
    createLead,
    updateLead,
    advanceStage,
    deleteLead,
} from "../service/opportunityService.js";
import {
    listMeetings,
    addMeeting,
    removeMeeting,
    listDocuments,
    addDocuments,
    removeDocument,
    getDocumentFile,
    listAttachments,
    addAttachment,
    INLINE_MIME,
} from "../service/leadAttachmentService.js";
import {
    listHistory,
    addHistoryNote,
    assignSalesperson,
    assignEstimator,
    assignCoordinator,
    notifyBusinessOwner,
    notifySalesManager,
    notifyOperationsCoordinator,
} from "../service/leadWorkflowService.js";
import { submitRequirements, submitClientInfo, submitChecklist } from "../service/estimationService.js";
import * as quotes from "../service/quoteService.js";
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

// ---- Job history ------------------------------------------------------------

export const getHistory = asyncHandler(async (req, res) => {
    const entries = await listHistory(req.params.id);

    res.status(200).json({ success: true, data: entries });
});

export const createHistoryEntry = asyncHandler(async (req, res) => {
    const entry = await addHistoryNote(req.params.id, req.body, req.user);

    res.status(201).json({ success: true, data: entry });
});

// ---- Meetings ---------------------------------------------------------------

export const getMeetings = asyncHandler(async (req, res) => {
    const meetings = await listMeetings(req.params.id);

    res.status(200).json({ success: true, data: meetings });
});

export const createMeeting = asyncHandler(async (req, res) => {
    const meeting = await addMeeting(req.params.id, req.body, req.user);

    res.status(201).json({ success: true, data: meeting });
});

export const deleteMeeting = asyncHandler(async (req, res) => {
    await removeMeeting(req.params.id, req.params.meetingId);

    res.status(200).json({ success: true, message: "Meeting removed" });
});

// ---- Attachments (lead screens: photo | sketch | bill | document) -------------

export const getAttachments = asyncHandler(async (req, res) => {
    const attachments = await listAttachments(req.params.id, req.user);

    res.status(200).json({ success: true, data: attachments });
});

export const createAttachment = asyncHandler(async (req, res) => {
    const attachment = await addAttachment(req.params.id, req.file, req.body?.category, req.user);

    res.status(201).json({ success: true, data: attachment });
});

// ---- Documents (generic: type, stage, label) --------------------------------
// Mutations return the refreshed opportunity so the client has one source of
// truth for the record and its documents.

export const getDocuments = asyncHandler(async (req, res) => {
    const documents = await listDocuments(req.params.id);

    res.status(200).json({ success: true, data: documents });
});

export const createDocuments = asyncHandler(async (req, res) => {
    await addDocuments(req.params.id, req.files || [], req.body, req.user);
    const opportunity = await getOpportunity(req.params.id);

    res.status(201).json({ success: true, data: opportunity });
});

export const deleteDocument = asyncHandler(async (req, res) => {
    await removeDocument(req.params.id, req.params.docId);
    const opportunity = await getOpportunity(req.params.id);

    res.status(200).json({ success: true, data: opportunity });
});

export const downloadDocument = asyncHandler(async (req, res) => {
    // A download-scoped token is bound to one document.
    const scoped = req.tokenPayload?.scope === "download";
    if (scoped && Number(req.tokenPayload.doc) !== Number(req.params.docId))
        return res.status(403).json({ success: false, message: "This link is for a different document" });

    const { doc, filePath } = await getDocumentFile(req.params.id, req.params.docId);
    const mime = doc.mime || "application/octet-stream";
    const inline = INLINE_MIME.test(mime) && req.query.download !== "1";

    return res.sendFile(filePath, {
        headers: {
            "Content-Type": mime,
            "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(doc.name)}`,
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
            "Cache-Control": "private, max-age=3600",
        },
    });
});

// ---- Assignments & notifications --------------------------------------------
// Each returns the refreshed opportunity.

export const setSalesperson = asyncHandler(async (req, res) => {
    await assignSalesperson(req.params.id, req.body, req.user);
    const opportunity = await getOpportunity(req.params.id);

    res.status(200).json({ success: true, data: opportunity });
});

export const setEstimator = asyncHandler(async (req, res) => {
    await assignEstimator(req.params.id, req.body, req.user);
    const opportunity = await getOpportunity(req.params.id);

    res.status(200).json({ success: true, data: opportunity });
});

export const setCoordinator = asyncHandler(async (req, res) => {
    await assignCoordinator(req.params.id, req.body, req.user);
    const opportunity = await getOpportunity(req.params.id);

    res.status(200).json({ success: true, data: opportunity });
});

export const notifyOwner = asyncHandler(async (req, res) => {
    const result = await notifyBusinessOwner(req.params.id, req.user);

    res.status(200).json({ success: true, data: result });
});

export const notifySales = asyncHandler(async (req, res) => {
    const result = await notifySalesManager(req.params.id, req.user);

    res.status(200).json({ success: true, data: result });
});

export const notifyOpsCoordinator = asyncHandler(async (req, res) => {
    const result = await notifyOperationsCoordinator(req.params.id, req.user);

    res.status(200).json({ success: true, data: result });
});

// ---- Estimation workflow (stage 2) ------------------------------------------
// Each returns the refreshed opportunity (the workflow state lives on it).

export const estimationRequirements = asyncHandler(async (req, res) => {
    await submitRequirements(req.params.id, req.body, req.user);
    const opportunity = await getOpportunity(req.params.id);

    res.status(200).json({ success: true, data: opportunity });
});

export const estimationClientInfo = asyncHandler(async (req, res) => {
    await submitClientInfo(req.params.id, req.body, req.user);
    const opportunity = await getOpportunity(req.params.id);

    res.status(200).json({ success: true, data: opportunity });
});

export const estimationChecklist = asyncHandler(async (req, res) => {
    await submitChecklist(req.params.id, req.body, req.user);
    const opportunity = await getOpportunity(req.params.id);

    res.status(200).json({ success: true, data: opportunity });
});

// ---- Quote ------------------------------------------------------------------

export const getQuote = asyncHandler(async (req, res) => {
    const quote = await quotes.getQuote(req.params.id);

    res.status(200).json({ success: true, data: quote }); // null until created
});

export const createQuote = asyncHandler(async (req, res) => {
    const quote = await quotes.createQuote(req.params.id, req.user);

    res.status(201).json({ success: true, data: quote });
});

export const updateQuote = asyncHandler(async (req, res) => {
    const quote = await quotes.updateQuote(req.params.id, req.body);

    res.status(200).json({ success: true, data: quote });
});

export const addQuoteItem = asyncHandler(async (req, res) => {
    const item = await quotes.addItem(req.params.id, req.body);

    res.status(201).json({ success: true, data: item });
});

export const updateQuoteItem = asyncHandler(async (req, res) => {
    const item = await quotes.updateItem(req.params.id, req.params.itemId, req.body);

    res.status(200).json({ success: true, data: item });
});

export const deleteQuoteItem = asyncHandler(async (req, res) => {
    await quotes.removeItem(req.params.id, req.params.itemId);

    res.status(200).json({ success: true, message: "Quote item removed" });
});

export const addQuoteCost = asyncHandler(async (req, res) => {
    const cost = await quotes.addCost(req.params.id, req.body);

    res.status(201).json({ success: true, data: cost });
});

export const updateQuoteCost = asyncHandler(async (req, res) => {
    const cost = await quotes.updateCost(req.params.id, req.params.costId, req.body);

    res.status(200).json({ success: true, data: cost });
});

export const deleteQuoteCost = asyncHandler(async (req, res) => {
    await quotes.removeCost(req.params.id, req.params.costId);

    res.status(200).json({ success: true, message: "Quote cost removed" });
});
