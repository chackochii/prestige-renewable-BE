// Excel downloads of job data (admin.export) — see exportService — and where
// each business unit's backups stand (backupReminder). The file is built in
// full before anything is sent, so a failure part-way answers with the usual
// JSON error rather than half a spreadsheet.

import asyncHandler from "../../../utils/asyncHandler.js";
import { successResponse } from "../../../utils/apiResponse.js";
import { exportJob, exportJobs } from "../service/exportService.js";
import { backupStatus } from "../service/backupReminder.js";

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const sendWorkbook = (res, { buffer, filename }) => {
    res.set({
        "Content-Type": XLSX_TYPE,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(buffer.length),
        // Customer data: never kept by a browser or proxy cache.
        "Cache-Control": "no-store",
    });
    res.end(buffer);
};

// GET /opportunities/:id/export → one job's workbook
export const exportOne = asyncHandler(async (req, res) => {
    sendWorkbook(res, await exportJob(req.params.id, req.user));
});

// GET /opportunities/export?businessUnitId=&stage=&lifecycle=&from=&to= → the unit's jobs
export const exportMany = asyncHandler(async (req, res) => {
    sendWorkbook(res, await exportJobs(req.query, req.user));
});

// GET /opportunities/export/backups → the caller's units, each with its last full backup
export const backups = asyncHandler(async (req, res) => {
    successResponse(res, { data: await backupStatus(req.user) });
});
