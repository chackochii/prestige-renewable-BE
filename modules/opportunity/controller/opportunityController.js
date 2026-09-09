import {
    listOpportunities,
    getOpportunity,
    createLead,
    updateLead,
    advanceStage,
    deleteLead,
} from "../service/opportunityService.js";
import {
    addMeeting,
    removeMeeting,
    listDocuments,
    addDocuments,
    removeDocument,
    getDocumentFile,
} from "../service/leadAttachmentService.js";
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

// ---- Meetings & documents (lead pack attachments) -------------------------
// Mutations return the refreshed opportunity so the client has one source of
// truth for the record, its meeting log and its documents.

export const createMeeting = asyncHandler(async (req, res) => {
    await addMeeting(req.params.id, req.body, req.user);
    const opportunity = await getOpportunity(req.params.id);

    res.status(201).json({ success: true, data: opportunity });
});

export const deleteMeeting = asyncHandler(async (req, res) => {
    await removeMeeting(req.params.id, req.params.meetingId);
    const opportunity = await getOpportunity(req.params.id);

    res.status(200).json({ success: true, data: opportunity });
});

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
    const { doc, filePath } = await getDocumentFile(req.params.id, req.params.docId);
    const disposition = req.query.download === "1" ? "attachment" : "inline";
    const fileName = encodeURIComponent(doc.name);

    res.sendFile(filePath, {
        headers: {
            "Content-Type": doc.mime || "application/octet-stream",
            "Content-Disposition": `${disposition}; filename*=UTF-8''${fileName}`,
            "Cache-Control": "private, max-age=3600",
        },
    });
});
