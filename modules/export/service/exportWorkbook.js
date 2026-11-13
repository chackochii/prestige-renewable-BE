// The Excel workbook for a job export (exportService loads the rows; this
// lays them out). Pure: rows in, an exceljs Workbook out — no queries here.
//
// One sheet per kind of record, every row starting with the job number, so the
// same layout serves one job (from its page) and a whole business unit (from
// the lists). A single job's workbook opens on a Summary of the record read
// top to bottom and leaves out sheets it has nothing for; a unit's workbook
// opens on Jobs, one row per job, and keeps every sheet so the files from two
// exports line up column for column.
//
// Cells hold real values — dates as dates, money as numbers — so the sheets
// sort, filter and add up. Excel dates carry no timezone, so every timestamp
// is written as the clock read where the business unit is (its timezone, said
// on the Export info sheet), the same as the screens show it.
//
// Uploaded files are not inside the workbook: the Documents sheet links to each.

import ExcelJS from "exceljs";
import { STAGE_LABELS } from "../../opportunity/service/stageAccess.js";
import { exGstTotalOf } from "../../opportunity/service/quoteService.js";
import { INSPECTION_FORM } from "../../collaboration/service/inspectionForm.js";
import { DEFAULT_TIME_ZONE } from "../../../utils/unitTime.js";

// ---- Values -----------------------------------------------------------------

/** Excel holds at most 32,767 characters in a cell; longer text is cut and says so. */
const MAX_CELL = 32000;
/** Characters XML 1.0 cannot carry — one of them in a cell makes Excel call the file corrupt. */
const XML_UNSAFE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

const cleanText = (value) => {
    if (value === null || value === undefined) return null;
    let text = String(value).replace(XML_UNSAFE, "");
    if (text.length > MAX_CELL) text = `${text.slice(0, MAX_CELL)}… (cut short: a spreadsheet cell holds 32,767 characters)`;
    return text === "" ? null : text;
};

/** The unit's timezone when this server's Intl knows it, else the default — a typo on the settings screen must not fail the export. */
export const safeZone = (zone) => {
    const wanted = typeof zone === "string" && zone.trim() ? zone.trim() : DEFAULT_TIME_ZONE;
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: wanted });
        return wanted;
    } catch {
        return DEFAULT_TIME_ZONE;
    }
};

const wallFormatters = new Map();
const wallFormatter = (timeZone) => {
    if (!wallFormatters.has(timeZone))
        wallFormatters.set(
            timeZone,
            new Intl.DateTimeFormat("en-US", {
                timeZone,
                hourCycle: "h23",
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
            })
        );
    return wallFormatters.get(timeZone);
};

/**
 * A moment as the clock read in `timeZone`, as a Date whose UTC fields are that
 * wall time — exceljs writes a Date's UTC fields, so the cell shows local time.
 */
const wallTime = (value, timeZone) => {
    const at = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(at.getTime())) return null;
    const parts = Object.fromEntries(wallFormatter(timeZone).formatToParts(at).map((part) => [part.type, part.value]));
    return new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second));
};

/** A calendar date: "2026-10-05" as stored (DATEONLY columns), or the unit's date at a moment. */
const calendarDate = (value, timeZone) => {
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
        const [y, m, d] = value.split("-").map(Number);
        return new Date(Date.UTC(y, m - 1, d));
    }
    const wall = wallTime(value, timeZone);
    return wall ? new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate())) : null;
};

const pad = (n) => String(n).padStart(2, "0");
const formatWall = (d) =>
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;

/** "siteAccessConfirmed" / "not_started" → "Site access confirmed" / "Not started". */
export const labelOf = (key) => {
    const words = String(key ?? "")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[_-]+/g, " ")
        .trim()
        .toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
};

/** Keys that are database ids: noise in a spreadsheet, the names are written instead. */
const isIdKey = (key) => key === "id" || /Id$/.test(key);
const ISO_MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const isFileSlot = (value) => value && typeof value === "object" && !Array.isArray(value) && typeof value.filename === "string";

/**
 * Anything stored as JSON (checklists, answers, notes with who and when) as
 * one line of text: "Reason: waiting on the council; By: Sam; At: 2026-10-02 14:05".
 * Timestamps are shown in the unit's time; drawn signatures as "(image)".
 */
export const describe = (value, timeZone) => {
    if (value === null || value === undefined || value === "") return "";
    if (typeof value === "boolean") return value ? "Yes" : "No";
    if (typeof value === "number") return String(value);
    if (value instanceof Date) {
        const wall = wallTime(value, timeZone);
        return wall ? formatWall(wall) : "";
    }
    if (typeof value === "string") {
        if (value.startsWith("data:")) return "(image)";
        if (ISO_MOMENT.test(value)) {
            const wall = wallTime(value, timeZone);
            return wall ? formatWall(wall) : value;
        }
        return value;
    }
    if (Array.isArray(value)) {
        const parts = value.map((item) => describe(item, timeZone)).filter(Boolean);
        const flat = value.every((item) => item === null || typeof item !== "object" || isFileSlot(item));
        return parts.join(flat ? ", " : "\n");
    }
    if (typeof value === "object") {
        if (isFileSlot(value)) return value.filename;
        return Object.entries(value)
            .filter(([key]) => !isIdKey(key))
            .map(([key, item]) => [key, describe(item, timeZone)])
            .filter(([, text]) => text !== "")
            .map(([key, text]) => `${labelOf(key)}: ${text}`)
            .join("; ");
    }
    return String(value);
};

/** One cell's value for a column type. */
const toCell = (type, value, timeZone) => {
    if (value === null || value === undefined || value === "") return null;
    switch (type) {
        case "datetime":
            return wallTime(value, timeZone);
        case "date":
            return calendarDate(value, timeZone);
        case "money":
        case "number": {
            const n = Number(value);
            return Number.isFinite(n) ? n : cleanText(value);
        }
        case "bool":
            return value === true ? "Yes" : value === false ? "No" : cleanText(value);
        case "link": {
            const url = String(value);
            // Excel refuses hyperlinks past ~2,000 characters; a longer one stays text.
            return /^https?:\/\//i.test(url) && url.length < 2000 ? { text: url, hyperlink: url } : cleanText(url);
        }
        default:
            return cleanText(typeof value === "object" ? describe(value, timeZone) : value);
    }
};

const FORMATS = { datetime: "yyyy-mm-dd hh:mm", date: "yyyy-mm-dd", money: "#,##0.00" };
const WIDTHS = { datetime: 17, date: 12, money: 14, number: 11, bool: 9, link: 60, text: 22, long: 50 };
const LINK_FONT = { color: { argb: "FF0563C1" }, underline: true };
const HEADER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EDF3" } };

const round2 = (n) => Math.round(n * 100) / 100;

// ---- Sheets -----------------------------------------------------------------

const styleHeader = (row) => {
    row.font = { bold: true };
    row.alignment = { vertical: "middle" };
    row.eachCell((cell) => {
        cell.fill = HEADER_FILL;
        cell.border = { bottom: { style: "thin", color: { argb: "FFB8C2CC" } } };
    });
};

/**
 * A sheet of rows under a header. columns: [{ header, key, type?, wrap? }] —
 * type picks the value conversion and number format (text by default); wrap
 * gives long text a wide, wrapping column.
 */
const addTable = (workbook, name, columns, rows, timeZone) => {
    const sheet = workbook.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
    sheet.columns = columns.map((column) => ({
        header: column.header,
        width: column.wrap ? WIDTHS.long : WIDTHS[column.type ?? "text"],
    }));
    for (const row of rows) {
        const added = sheet.addRow(columns.map((column) => toCell(column.type, row[column.key], timeZone)));
        columns.forEach((column, i) => {
            const cell = added.getCell(i + 1);
            if (FORMATS[column.type] && cell.value instanceof Date) cell.numFmt = FORMATS[column.type];
            if (column.type === "money" && typeof cell.value === "number") cell.numFmt = FORMATS.money;
            if (column.type === "link" && cell.value?.hyperlink) cell.font = LINK_FONT;
            if (column.wrap) cell.alignment = { wrapText: true, vertical: "top" };
        });
    }
    styleHeader(sheet.getRow(1));
    if (rows.length) sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
    return sheet;
};

/** Field | Value rows, each value converted by its own type — the one-job Summary and Export info. */
const addFieldSheet = (workbook, name, fields, timeZone, { sectioned = false } = {}) => {
    const sheet = workbook.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
    sheet.columns = [
        ...(sectioned ? [{ header: "Section", width: 20 }] : []),
        { header: "Field", width: 34 },
        { header: "Value", width: 70 },
    ];
    for (const field of fields) {
        const value = toCell(field.type, field.value, timeZone);
        const row = sheet.addRow([...(sectioned ? [field.section] : []), field.label, value]);
        const cell = row.getCell(sectioned ? 3 : 2);
        if (FORMATS[field.type] && value instanceof Date) cell.numFmt = FORMATS[field.type];
        if (field.type === "money" && typeof value === "number") cell.numFmt = FORMATS.money;
        if (field.type === "link" && value?.hyperlink) cell.font = LINK_FONT;
        // Numbers and dates read best on the left, under the text values.
        cell.alignment = { wrapText: true, vertical: "top", horizontal: "left" };
    }
    styleHeader(sheet.getRow(1));
    return sheet;
};

// ---- The job record ---------------------------------------------------------

const f = (section, label, get, type = "text") => ({ section, label, get, type });
const stageText = (stage) => (stage ? `${stage} · ${STAGE_LABELS[stage] ?? `Stage ${stage}`}` : null);
const customFieldsText = (list) =>
    (Array.isArray(list) ? list : [])
        .filter((item) => item?.label || item?.value)
        .map((item) => `${item.label ?? ""}: ${item.value ?? ""}`)
        .join("\n");

/**
 * Every field on the opportunity, in the order the lead pack and the stages
 * fill them. The one-job Summary lists them down the page; the unit's Jobs
 * sheet has one column each, headed by the label (so labels are unique).
 */
const JOB_FIELDS = [
    f("Job", "Job number", (o) => o.number),
    f("Job", "Business unit", (o, x) => x.unit?.name),
    f("Job", "Stage", (o) => stageText(o.stage)),
    f("Job", "Lifecycle", (o) => o.lifecycle),
    f("Job", "Lost reason", (o) => (o.lostReason ? labelOf(o.lostReason) : null)),
    f("Job", "Qualification", (o) => labelOf(o.qualification)),
    f("Job", "Not a potential client because", (o) => o.notPotentialReason),
    f("Job", "Created", (o) => o.createdAt, "datetime"),
    f("Job", "Last updated", (o) => o.updatedAt, "datetime"),
    f("Job", "Stage started", (o) => o.slaStartedAt, "datetime"),
    f("Job", "Stage due", (o) => o.slaDueAt, "datetime"),
    f("Job", "Closed", (o) => o.closedAt, "datetime"),
    f("Job", "Variation pending", (o) => o.variationPending, "bool"),

    f("Lead source", "Lead type", (o) => (o.leadType ? labelOf(o.leadType) : null)),
    f("Lead source", "Lead source", (o) => labelOf(o.leadSource)),
    f("Lead source", "Lead source details", (o) => o.leadSourceDetails),
    f("Lead source", "Referrer", (o) => o.referrer?.organisation || o.referrerName),
    f("Lead source", "Campaign", (o) => o.campaign?.name),
    f("Lead source", "Involvement tier", (o) => (o.involvementTier ? labelOf(o.involvementTier) : null)),

    f("Customer", "Customer first name", (o) => o.customerFirstName),
    f("Customer", "Customer last name", (o) => o.customerLastName),
    f("Customer", "Legal name", (o) => o.customerLegalName),
    f("Customer", "Trading name", (o) => o.customerTradingName),
    f("Customer", "ABN", (o) => o.customerAbn),
    f("Customer", "Customer email", (o) => o.customerEmail),
    f("Customer", "Customer phone", (o) => o.customerPhone),
    f("Customer", "Billing address", (o) => o.customerBillingAddress),
    f("Customer", "Billing same as site", (o) => (o.billingSameAsSite ? labelOf(o.billingSameAsSite) : null)),
    f("Customer", "Preferred language", (o) => o.preferredLanguage || "English"),
    f("Customer", "Customer comments", (o) => o.customerComments),
    f("Customer", "Intent confirmed", (o) => o.customerIntentConfirmed, "bool"),
    f("Customer", "Budget", (o) => o.customerBudget, "money"),
    f("Customer", "Business offers", (o) => o.businessOffers),

    f("Site", "Site address", (o) => o.siteLine1),
    f("Site", "Suburb", (o) => o.siteSuburb),
    f("Site", "State", (o) => o.siteState),
    f("Site", "Postcode", (o) => o.sitePostcode),
    f("Site", "Jurisdiction", (o) => o.siteJurisdiction),
    f("Site", "Site contact", (o) => o.siteContact),
    f("Site", "Site access notes", (o) => o.siteAccessNotes),
    f("Site", "Site map", (o) => o.siteMapUrl, "link"),

    f("Contact", "Contact name", (o) => o.contactName),
    f("Contact", "Contact role", (o) => o.contactRole),
    f("Contact", "Contact email", (o) => o.contactEmail),
    f("Contact", "Contact phone", (o) => o.contactPhone),

    f("People", "Lead owner", (o, x) => x.name(o.leadOwnerId)),
    f("People", "Salesperson", (o, x) => x.name(o.salespersonId)),
    f("People", "Estimator", (o, x) => x.name(o.estimatorId)),
    f("People", "Operations coordinator", (o, x) => x.name(o.operationalCoordinatorId)),
    f("People", "Delivery owner", (o, x) => x.name(o.deliveryOwnerId)),
    f("People", "Site visit assignee", (o, x) => x.name(o.estimationSiteVisitAssigneeId)),
    f("People", "Unassigned because", (o) => o.unassignedReason),

    f("Value", "Estimated value (ex GST)", (o) => o.estimatedValue, "money"),
    f("Value", "Accepted value (ex GST)", (o) => o.acceptedValue, "money"),
    f("Value", "Margin floor %", (o) => o.marginFloor, "number"),
    f("Value", "Owner discount", (o) => o.hasOwnerDiscount, "bool"),
    f("Value", "Owner discount name", (o) => o.ownerDiscountName),
    f("Value", "Owner discount amount", (o) => o.ownerDiscountAmount, "money"),

    f("Lead checklist", "Job requirement", (o) => o.serviceRequirement),
    f("Lead checklist", "Storeys", (o) => o.propertyStoreys),
    f("Lead checklist", "Roof type", (o) => o.roofType),
    f("Lead checklist", "Electrical phase", (o) => o.electricalPhase),
    f("Lead checklist", "Finance assistance", (o) => o.financeAssistance),
    f("Lead checklist", "Finance notes", (o) => o.financeNotes),
    f("Lead checklist", "No site requirements", (o) => o.siteRequirementsNone, "bool"),
    f("Lead checklist", "Site specific requirements", (o) => o.siteSpecificRequirements),
    f("Lead checklist", "Preferred install timeframe", (o) => o.preferredInstallTimeframe),
    f("Lead checklist", "Preferred install location", (o) => o.preferredInstallLocation),
    f("Lead checklist", "Annual usage (kWh)", (o) => o.energyAnnualKwh, "number"),
    f("Lead checklist", "Energy bills on file", (o) => o.energyHasBills, "bool"),
    f("Lead checklist", "Energy notes", (o) => o.energyNotes),
    f("Lead checklist", "Client had to be contacted", (o) => o.needsClientContact, "bool"),
    f("Lead checklist", "Contact attempts", (o) => o.contactAttempts),
    f("Lead checklist", "Client visit needed", (o) => o.needsClientVisit, "bool"),
    f("Lead checklist", "Client visit reason", (o) => o.clientVisitReason),
    f("Lead checklist", "Custom fields", (o) => customFieldsText(o.customFields)),
    f("Lead checklist", "Next action", (o) => o.nextAction),
    f("Lead checklist", "Next action due", (o) => o.nextActionDueAt, "date"),
    f("Lead checklist", "Notes", (o) => o.notes),
    f("Lead checklist", "Feedback", (o) => o.feedback),

    f("Estimation", "Requirements received", (o) => o.estimationRequirementsReceived, "bool"),
    f("Estimation", "Requirements checklist", (o) => o.estimationRequirementsChecklist),
    f("Estimation", "Estimation on hold because", (o) => o.estimationOnHoldReason),
    f("Estimation", "Client info needed", (o) => o.estimationClientInfoNeeded, "bool"),
    f("Estimation", "Pre-site inspection required", (o) => o.estimationPreSiteInspectionRequired, "bool"),
    f("Estimation", "Site visit completed", (o) => o.estimationSiteVisitCompleted, "bool"),
    f("Estimation", "Estimation checklist", (o) => o.estimationChecklistValues),
    f("Estimation", "Estimation inputs", (o) => o.estimationInput),
    f("Estimation", "Inputs accepted", (o) => o.estimationInputsAcceptedAt, "datetime"),
    f("Estimation", "Inputs accepted by", (o, x) => x.name(o.estimationInputsAcceptedById)),
    f("Estimation", "Lead edited after hand-over", (o) => o.leadEditedAt, "datetime"),
    f("Estimation", "Lead change summary", (o) => o.leadChangeSummary),
    f("Estimation", "Lead change acknowledged", (o) => o.leadChangeAcknowledgedAt, "datetime"),
    f("Estimation", "Re-quote requested", (o) => o.requoteRequestedAt, "datetime"),
    f("Estimation", "Site inspection", (o) => o.inspection),
    f("Estimation", "Estimate notes", (o) => o.estimateNotes),
    f("Estimation", "External quotes", (o) => o.externalQuotes),

    f("Approvals", "Required approvals", (o) => o.requiredApprovals),
    f("Approvals", "Job-only approval types", (o) => o.customApprovalTypes),
    f("Approvals", "Approvals on hold", (o) => o.approvalHold),
    f("Approvals", "Sent to procurement", (o) => o.approvalSent),
    f("Approvals", "Approvals reopened", (o) => o.approvalReopened),
    f("Approvals", "Approval review needed", (o) => o.approvalReview),
    f("Approvals", "Returned from approvals", (o) => o.approvalReturn),

    f("Delivery", "Install window start", (o) => o.installWindowStart, "date"),
    f("Delivery", "Install window end", (o) => o.installWindowEnd, "date"),
    f("Delivery", "Electrical contractor", (o) => o.electricalContractor),
    f("Delivery", "Civil contractor", (o) => o.civilContractor),
    f("Delivery", "Job baseline", (o) => o.jobBaseline),
    f("Delivery", "Site works", (o) => o.siteWorksMeta),
    f("Delivery", "Additional costs", (o) => o.additionalCosts),
    f("Delivery", "Final labour cost", (o) => o.laborCostFinal, "money"),
    f("Delivery", "Operationally complete", (o) => o.operationalComplete, "bool"),
    f("Delivery", "Financially complete", (o) => o.financialComplete, "bool"),

    f("Closure", "Closure checklist complete", (o) => o.closureChecklistComplete, "bool"),
    f("Closure", "Warranty contact", (o) => o.closureWarrantyContact),
    f("Closure", "Future engagement", (o) => o.closureFutureEngagement),
    f("Closure", "Service", (o) => o.service),
    f("Closure", "Post-work enquiries", (o) => o.postWorkEnquiries),
];

// Long text gets a wide, wrapping column on the Jobs sheet.
const LONG_FIELDS = new Set([
    "Customer comments", "Site access notes", "Contact attempts", "Custom fields", "Notes", "Feedback",
    "Estimation checklist", "Estimation inputs", "Lead change summary", "Site inspection", "Estimate notes",
    "Job baseline", "Approvals on hold", "Sent to procurement", "Approvals reopened", "Approval review needed",
    "Returned from approvals", "Service", "Post-work enquiries",
]);

// ---- Child records ----------------------------------------------------------

const KIND_LABELS = { cost: "Cost", rebate: "Rebate", discount: "Discount" };
const CHECKLIST_SECTIONS = { boq: "BOQ", quote: "Supplier quote", po: "Purchase order", receipt: "Delivery receipt", jobCreation: "Job creation" };
const CHANNELS = { customer: "Customer link", staff: "Recorded by staff" };
const FORM_LABELS = new Map(INSPECTION_FORM.map((field) => [field.key, field.label]));
const FORM_ORDER = new Map(INSPECTION_FORM.map((field, i) => [field.key, i]));

const lineTotal = (item) =>
    round2((Number(item?.quantity) || 0) * (Number(item?.unitPrice) || 0) * (1 - (Number(item?.discountPct) || 0) / 100));

/** A quote's lines — the items, then the costs, rebates and discounts added on top. */
const quoteLines = (items = [], costs = []) => [
    ...[...items]
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || (a.id ?? 0) - (b.id ?? 0))
        .map((item) => ({
            line: "Item",
            item: item.itemName,
            brand: item.brand,
            unit: item.unit,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            discountPct: item.discountPct,
            lineTotal: lineTotal(item),
        })),
    ...[...costs]
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || (a.id ?? 0) - (b.id ?? 0))
        .map((cost) => ({
            line: KIND_LABELS[cost.kind ?? "cost"] ?? labelOf(cost.kind),
            item: cost.costType,
            calculation: cost.calcType === "percentage" ? "Percentage" : "Fixed amount",
            value: cost.value,
            description: cost.description,
        })),
];

const LINE_COLUMNS = [
    { header: "Line", key: "line" },
    { header: "Item / cost type", key: "item" },
    { header: "Brand", key: "brand" },
    { header: "Unit", key: "unit" },
    { header: "Quantity", key: "quantity", type: "number" },
    { header: "Unit price", key: "unitPrice", type: "money" },
    { header: "Discount %", key: "discountPct", type: "number" },
    { header: "Line total", key: "lineTotal", type: "money" },
    { header: "Calculation", key: "calculation" },
    { header: "Value ($ or %)", key: "value", type: "number" },
    { header: "Description", key: "description", wrap: true },
];

/** BOQ line key → "Solar panel (Jinko Tiger Neo 440W)", for a purchase order's lines. */
const boqNames = (procurementJob) =>
    new Map(
        (Array.isArray(procurementJob?.boq) ? procurementJob.boq : []).map((line) => [
            line.key,
            [line.item, line.brand ? `(${line.brand})` : ""].filter(Boolean).join(" "),
        ])
    );

const JOB_COLUMN = { header: "Job", key: "job" };

/**
 * The sheets after the job record, in workbook order. Each: name, columns
 * (after the Job column) and the rows for all the jobs, in the jobs' order.
 */
const childSheets = (x) => {
    const { timeZone } = x;
    const procurementByJob = new Map(x.procurementJobs.map((pj) => [pj.opportunityId, pj]));
    const requestById = new Map(x.requests.map((request) => [request.id, request]));
    const job = (opportunityId) => x.number(opportunityId);

    return [
        {
            // Not "History": Excel keeps that sheet name for itself.
            name: "Job history",
            columns: [
                { header: "When", key: "at", type: "datetime" },
                { header: "Type", key: "kind" },
                { header: "By", key: "by" },
                { header: "Entry", key: "note", wrap: true },
            ],
            rows: x.history.map((entry) => ({
                job: job(entry.opportunityId),
                opportunityId: entry.opportunityId,
                at: entry.createdAt,
                kind: entry.kind === "system" ? "System" : "Note",
                by: x.name(entry.authorId),
                note: entry.note,
            })),
        },
        {
            name: "Meetings",
            columns: [
                { header: "When", key: "at", type: "datetime" },
                { header: "Attendees", key: "attendees" },
                { header: "Outcome", key: "outcome", wrap: true },
                { header: "Next step", key: "nextStep", wrap: true },
                { header: "Recorded by", key: "by" },
            ],
            rows: x.jobs.flatMap((o) =>
                (Array.isArray(o.meetings) ? o.meetings : []).map((meeting) => ({
                    job: o.number,
                    opportunityId: o.id,
                    at: meeting.at,
                    attendees: meeting.attendees,
                    outcome: meeting.outcome,
                    nextStep: meeting.nextStep,
                    by: meeting.actorName || x.name(meeting.actorId),
                }))
            ),
        },
        {
            name: "Quotes",
            columns: [
                { header: "Quote number", key: "quoteNumber" },
                { header: "Status", key: "status" },
                { header: "Project", key: "project" },
                { header: "Project type", key: "projectType" },
                { header: "Quote date", key: "quoteDate", type: "date" },
                { header: "GST", key: "taxTreatment" },
                { header: "GST rate %", key: "gstRatePct", type: "number" },
                { header: "Annual savings", key: "annualSavings", type: "money" },
                { header: "Current annual bill", key: "currentAnnualBill", type: "money" },
                { header: "Savings worked out as", key: "savingsBasis", wrap: true },
                { header: "Generated", key: "generatedAt", type: "datetime" },
                { header: "Created by", key: "createdBy" },
                { header: "Created", key: "createdAt", type: "datetime" },
            ],
            rows: x.quotes.map((quote) => ({
                job: job(quote.opportunityId),
                opportunityId: quote.opportunityId,
                quoteNumber: quote.quoteNumber,
                status: labelOf(quote.status),
                project: quote.project,
                projectType: quote.projectType === "Other" && quote.projectTypeOther ? `Other: ${quote.projectTypeOther}` : quote.projectType,
                quoteDate: quote.quoteDate,
                taxTreatment: labelOf(quote.taxTreatment),
                gstRatePct: quote.gstRatePct,
                annualSavings: quote.annualSavings,
                currentAnnualBill: quote.currentAnnualBill,
                savingsBasis: quote.savingsBasis,
                generatedAt: quote.generatedAt,
                createdBy: x.name(quote.createdById),
                createdAt: quote.createdAt,
            })),
        },
        {
            name: "Quote lines",
            columns: [{ header: "Quote number", key: "quoteNumber" }, ...LINE_COLUMNS],
            rows: x.quotes.flatMap((quote) =>
                quoteLines(quote.items, quote.additionalCosts).map((line) => ({
                    job: job(quote.opportunityId),
                    opportunityId: quote.opportunityId,
                    quoteNumber: quote.quoteNumber,
                    ...line,
                }))
            ),
        },
        {
            name: "Quote versions",
            columns: [
                { header: "Version", key: "version", type: "number" },
                { header: "Quote number", key: "quoteNumber" },
                { header: "Invoice number", key: "invoiceNumber" },
                { header: "Total as issued", key: "grandTotal", type: "money" },
                { header: "Total ex GST", key: "exGst", type: "money" },
                { header: "GST", key: "taxTreatment" },
                { header: "Saved", key: "createdAt", type: "datetime" },
                { header: "Saved by", key: "createdBy" },
            ],
            rows: x.versions.map((version) => ({
                job: job(version.opportunityId),
                opportunityId: version.opportunityId,
                version: version.version,
                quoteNumber: version.quoteNumber,
                invoiceNumber: version.invoiceNumber,
                grandTotal: version.grandTotal,
                exGst: exGstTotalOf(version),
                taxTreatment: version.snapshot?.quote?.taxTreatment ? labelOf(version.snapshot.quote.taxTreatment) : null,
                createdAt: version.createdAt,
                createdBy: x.name(version.createdById),
            })),
        },
        {
            name: "Version lines",
            columns: [{ header: "Version", key: "version", type: "number" }, { header: "Quote number", key: "quoteNumber" }, ...LINE_COLUMNS],
            rows: x.versions.flatMap((version) =>
                quoteLines(version.snapshot?.quote?.items ?? [], version.snapshot?.quote?.additionalCosts ?? []).map((line) => ({
                    job: job(version.opportunityId),
                    opportunityId: version.opportunityId,
                    version: version.version,
                    quoteNumber: version.quoteNumber,
                    ...line,
                }))
            ),
        },
        {
            name: "Proposals",
            columns: [
                { header: "Proposal", key: "number" },
                { header: "Version", key: "version", type: "number" },
                { header: "Quote version", key: "quoteVersion", type: "number" },
                { header: "Status", key: "status" },
                { header: "Total", key: "grandTotal", type: "money" },
                { header: "Sent to", key: "sentTo" },
                { header: "Sent by", key: "sentBy" },
                { header: "Sent", key: "issuedAt", type: "datetime" },
                { header: "Link expires", key: "expiresAt", type: "datetime" },
                { header: "First viewed", key: "viewedAt", type: "datetime" },
                { header: "Views", key: "viewCount", type: "number" },
                { header: "Customer answer", key: "response" },
                { header: "Answered", key: "respondedAt", type: "datetime" },
                { header: "Answered by", key: "responseName" },
                { header: "Customer note", key: "responseNote", wrap: true },
                { header: "Answered through", key: "channel" },
                { header: "Recorded by", key: "recordedBy" },
                { header: "Rejection reason", key: "rejectionReason", wrap: true },
                { header: "Email subject", key: "emailSubject" },
                { header: "Email message", key: "emailMessage", wrap: true },
            ],
            rows: x.proposals.map((proposal) => ({
                job: job(proposal.opportunityId),
                opportunityId: proposal.opportunityId,
                number: proposal.number,
                version: proposal.version,
                quoteVersion: proposal.quoteVersion?.version,
                status: labelOf(proposal.status),
                grandTotal: proposal.grandTotal,
                sentTo: proposal.sentTo,
                sentBy: x.name(proposal.sentById),
                issuedAt: proposal.issuedAt,
                expiresAt: proposal.expiresAt,
                viewedAt: proposal.viewedAt,
                viewCount: proposal.viewCount,
                response: proposal.response ? labelOf(proposal.response) : null,
                respondedAt: proposal.respondedAt,
                responseName: proposal.responseName,
                responseNote: proposal.responseNote,
                channel: CHANNELS[proposal.responseChannel] ?? proposal.responseChannel,
                recordedBy: x.name(proposal.recordedById),
                rejectionReason: proposal.rejectionReason,
                emailSubject: proposal.emailSubject,
                emailMessage: proposal.emailMessage,
            })),
        },
        {
            name: "Re-quotes",
            columns: [
                { header: "Round", key: "round", type: "number" },
                { header: "Status", key: "status" },
                { header: "Customer message", key: "customerMessage", wrap: true },
                { header: "Customer name", key: "customerName" },
                { header: "Sales comments", key: "comments", wrap: true },
                { header: "Requested by", key: "requestedBy" },
                { header: "Requested", key: "createdAt", type: "datetime" },
                { header: "Estimator", key: "estimator" },
                { header: "Completed", key: "completedAt", type: "datetime" },
                { header: "Completed by", key: "completedBy" },
                { header: "Estimator note", key: "estimatorNote", wrap: true },
            ],
            rows: x.requotes.map((round) => ({
                job: job(round.opportunityId),
                opportunityId: round.opportunityId,
                round: round.round,
                status: labelOf(round.status),
                customerMessage: round.customerMessage,
                customerName: round.customerName,
                comments: round.comments,
                requestedBy: x.name(round.requestedById),
                createdAt: round.createdAt,
                estimator: x.name(round.estimatorId),
                completedAt: round.completedAt,
                completedBy: x.name(round.completedById),
                estimatorNote: round.estimatorNote,
            })),
        },
        {
            name: "Approvals",
            columns: [
                { header: "Approval", key: "label" },
                { header: "Required", key: "required", type: "bool" },
                { header: "Status", key: "status" },
                { header: "Owner role", key: "ownerRole" },
                { header: "Authority", key: "authority" },
                { header: "Reference", key: "reference" },
                { header: "Lodged by", key: "owner" },
                { header: "Submitted", key: "submittedAt", type: "datetime" },
                { header: "Outcome", key: "outcomeAt", type: "datetime" },
                { header: "Notes", key: "notes", wrap: true },
                { header: "Document", key: "documentName" },
                { header: "Checklist", key: "checklist", wrap: true },
            ],
            rows: x.approvals.map((approval) => ({
                job: job(approval.opportunityId),
                opportunityId: approval.opportunityId,
                label: approval.label || labelOf(approval.type),
                required: approval.required,
                status: labelOf(approval.status),
                ownerRole: approval.ownerRole,
                authority: approval.authority,
                reference: approval.reference,
                owner: x.name(approval.ownerId),
                submittedAt: approval.submittedAt,
                outcomeAt: approval.outcomeAt,
                notes: approval.notes,
                documentName: approval.documentName,
                checklist: describe(approval.checklist, timeZone),
            })),
        },
        {
            name: "Procurement BOQ",
            columns: [
                { header: "Item", key: "item" },
                { header: "Kind", key: "kind" },
                { header: "Brand", key: "brand" },
                { header: "Unit", key: "unit" },
                { header: "Proposal qty", key: "proposalQty", type: "number" },
                { header: "Site qty", key: "siteQty", type: "number" },
                { header: "Proposal unit cost", key: "proposalUnitCost", type: "money" },
                { header: "Quoted unit cost", key: "quotedUnitCost", type: "money" },
                { header: "Supplier", key: "supplier" },
                { header: "In inventory", key: "inInventory", type: "bool" },
                { header: "Availability", key: "availability" },
                { header: "Lead time (days)", key: "leadTimeDays", type: "number" },
            ],
            rows: x.procurementJobs.flatMap((pj) =>
                (Array.isArray(pj.boq) ? pj.boq : []).map((line) => ({
                    job: job(pj.opportunityId),
                    opportunityId: pj.opportunityId,
                    ...line,
                    kind: line.kind ? labelOf(line.kind) : null,
                    availability: line.availability ? labelOf(line.availability) : null,
                }))
            ),
        },
        {
            name: "Supplier quotes",
            columns: [
                { header: "Supplier", key: "supplier" },
                { header: "Total", key: "total", type: "money" },
                { header: "Received", key: "receivedAt", type: "datetime" },
                { header: "Valid until", key: "validUntil", type: "date" },
                { header: "Note", key: "note", wrap: true },
            ],
            rows: x.procurementJobs.flatMap((pj) =>
                (Array.isArray(pj.quotes) ? pj.quotes : []).map((quote) => ({
                    job: job(pj.opportunityId),
                    opportunityId: pj.opportunityId,
                    ...quote,
                }))
            ),
        },
        {
            // Everything else on the procurement record, one answer a row, so a
            // checklist question added later still lands somewhere readable.
            name: "Procurement record",
            columns: [
                { header: "Section", key: "section" },
                { header: "Item", key: "item" },
                { header: "Value", key: "value", wrap: true },
            ],
            rows: x.procurementJobs.flatMap((pj) => {
                const base = { job: job(pj.opportunityId), opportunityId: pj.opportunityId };
                const rows = [];
                if (pj.enteredAt) rows.push({ ...base, section: "Procurement", item: "Entered procurement", value: describe(pj.enteredAt, timeZone) });
                for (const [section, answers] of Object.entries(pj.checklist ?? {})) {
                    const title = `Checklist: ${CHECKLIST_SECTIONS[section] ?? labelOf(section)}`;
                    if (answers && typeof answers === "object" && !Array.isArray(answers)) {
                        for (const [key, answer] of Object.entries(answers))
                            rows.push({ ...base, section: title, item: labelOf(key), value: describe(answer, timeZone) });
                    } else rows.push({ ...base, section: title, item: "", value: describe(answers, timeZone) });
                }
                for (const [key, answer] of Object.entries(pj.greenDeal ?? {}))
                    rows.push({ ...base, section: "Green Deal", item: labelOf(key), value: describe(answer, timeZone) });
                (Array.isArray(pj.approvals) ? pj.approvals : []).forEach((approval, i) =>
                    rows.push({ ...base, section: "Variation approval", item: approval?.role ? `${i + 1}. ${approval.role}` : String(i + 1), value: describe(approval, timeZone) })
                );
                (Array.isArray(pj.revisions) ? pj.revisions : []).forEach((revision, i) =>
                    rows.push({ ...base, section: "BOQ revision", item: String(i + 1), value: describe(revision, timeZone) })
                );
                return rows;
            }),
        },
        {
            name: "Purchase orders",
            columns: [
                { header: "PO number", key: "ref" },
                { header: "Supplier", key: "supplier" },
                { header: "Status", key: "status" },
                { header: "Items", key: "items", wrap: true },
                { header: "Amount", key: "amount", type: "money" },
                { header: "Supplier ETA", key: "eta", type: "date" },
                { header: "Delivery slot", key: "scheduledFor", type: "date" },
                { header: "Sent", key: "sentAt", type: "datetime" },
                { header: "Confirmed", key: "confirmedAt", type: "datetime" },
                { header: "Delivered", key: "deliveredAt", type: "datetime" },
                { header: "Received by", key: "receivedBy" },
                { header: "Created by", key: "createdBy" },
                { header: "Approved by", key: "approvedBy" },
                { header: "Approved", key: "approvedAt", type: "datetime" },
                { header: "Review flag", key: "reviewFlag", wrap: true },
            ],
            rows: x.purchaseOrders.map((po) => {
                const names = boqNames(procurementByJob.get(po.opportunityId));
                const lines = (Array.isArray(po.lines) ? po.lines : [])
                    .map((line) => (typeof line === "string" ? names.get(line) || line : describe(line, timeZone)))
                    .filter(Boolean);
                return {
                    job: job(po.opportunityId),
                    opportunityId: po.opportunityId,
                    ref: po.ref,
                    supplier: po.supplier,
                    status: labelOf(po.status),
                    items: lines.length ? lines.join("\n") : po.items,
                    amount: po.amount,
                    eta: po.eta,
                    scheduledFor: po.scheduledFor,
                    sentAt: po.sentAt,
                    confirmedAt: po.confirmedAt,
                    deliveredAt: po.deliveredAt,
                    receivedBy: po.receivedBy,
                    createdBy: x.name(po.createdById),
                    approvedBy: x.name(po.approvedById),
                    approvedAt: po.approvedAt,
                    reviewFlag: describe(po.reviewFlag, timeZone),
                };
            }),
        },
        {
            name: "Requests",
            columns: [
                { header: "Kind", key: "kind" },
                { header: "Department", key: "department" },
                { header: "Raised at stage", key: "stage" },
                { header: "Title", key: "title" },
                { header: "Description", key: "description", wrap: true },
                { header: "Priority", key: "priority" },
                { header: "Status", key: "status" },
                { header: "Requested by", key: "createdBy" },
                { header: "Assigned to", key: "assignee" },
                { header: "Raised", key: "createdAt", type: "datetime" },
                { header: "Due", key: "dueAt", type: "datetime" },
                { header: "Scheduled for", key: "scheduledFor", type: "datetime" },
                { header: "Response", key: "responseNote", wrap: true },
                { header: "Answers", key: "responseFields", wrap: true },
                { header: "Responded", key: "responseSubmittedAt", type: "datetime" },
                { header: "Responded by", key: "respondedBy" },
                { header: "Clarification note", key: "clarificationNote", wrap: true },
                { header: "Cancelled because", key: "cancelledReason", wrap: true },
            ],
            rows: x.requests.map((request) => ({
                job: job(request.opportunityId),
                opportunityId: request.opportunityId,
                kind: labelOf(request.kind),
                department: labelOf(request.department),
                stage: stageText(request.stage),
                title: request.title,
                description: request.description,
                priority: labelOf(request.priority),
                status: labelOf(request.status),
                createdBy: x.name(request.createdById),
                assignee: x.name(request.assigneeId),
                createdAt: request.createdAt,
                dueAt: request.dueAt,
                scheduledFor: request.scheduledFor,
                responseNote: request.responseNote,
                responseFields: describe(request.responseFields, timeZone),
                responseSubmittedAt: request.responseSubmittedAt,
                respondedBy: x.name(request.responseSubmittedById),
                clarificationNote: request.clarificationNote,
                cancelledReason: request.cancelledReason,
            })),
        },
        {
            // The pre-site inspection form (CL-04), one answer a row.
            name: "Site visits",
            columns: [
                { header: "Request", key: "request" },
                { header: "Form status", key: "status" },
                { header: "Crew member", key: "crew" },
                { header: "Crew email", key: "email" },
                { header: "Crew phone", key: "phone" },
                { header: "Submitted", key: "submittedAt", type: "datetime" },
                { header: "Question", key: "question", wrap: true },
                { header: "Answer", key: "answer", wrap: true },
            ],
            rows: x.siteVisits.flatMap((visit) => {
                const request = requestById.get(visit.requestId);
                if (!request) return [];
                const response = visit.response && typeof visit.response === "object" ? visit.response : null;
                const labels = new Map([
                    ...FORM_LABELS,
                    ...(Array.isArray(visit.requestedFields) ? visit.requestedFields : [])
                        .filter((field) => field?.key && field?.label)
                        .map((field) => [field.key, field.label]),
                ]);
                const base = {
                    job: job(request.opportunityId),
                    opportunityId: request.opportunityId,
                    request: request.title,
                    status: labelOf(visit.status),
                    crew: visit.assigneeName || response?.name || x.name(visit.assigneeId),
                    email: visit.assigneeEmail || response?.email,
                    phone: visit.assigneePhone || response?.phone,
                    submittedAt: visit.submittedAt,
                };
                const answers = Object.entries(response?.fields ?? {}).sort(
                    ([a], [b]) => (FORM_ORDER.get(a) ?? 999) - (FORM_ORDER.get(b) ?? 999)
                );
                if (!answers.length) return [{ ...base, question: null, answer: response ? null : "Not submitted yet" }];
                return answers.map(([key, answer]) => ({
                    ...base,
                    question: labels.get(key) ?? labelOf(key),
                    answer: typeof answer === "string" && answer.startsWith("data:") ? "Signed" : describe(answer, timeZone),
                }));
            }),
        },
        {
            name: "Documents",
            columns: [
                { header: "File", key: "file" },
                { header: "Kept with", key: "source" },
                { header: "Type", key: "type" },
                { header: "Category", key: "category" },
                { header: "Stage", key: "stage" },
                { header: "Uploaded by", key: "uploadedBy" },
                { header: "Uploaded", key: "uploadedAt", type: "datetime" },
                { header: "Size", key: "size" },
                { header: "Link", key: "link", type: "link" },
            ],
            rows: [
                ...x.documents.map((doc) => ({
                    job: job(doc.opportunityId),
                    opportunityId: doc.opportunityId,
                    file: doc.name,
                    source: "Job documents",
                    type: labelOf(doc.type),
                    category: doc.category ? labelOf(doc.category) : null,
                    stage: stageText(doc.stage),
                    uploadedBy: x.name(doc.uploaderId),
                    uploadedAt: doc.createdAt,
                    size: doc.size,
                    link: doc.link,
                })),
                ...x.requests.flatMap((request) =>
                    (request.attachments ?? []).map((attachment) => ({
                        job: job(request.opportunityId),
                        opportunityId: request.opportunityId,
                        file: attachment.filename,
                        source: `Request: ${request.title}`,
                        type: labelOf(attachment.category),
                        category: attachment.documentKey ? labelOf(attachment.documentKey) : null,
                        stage: stageText(request.stage),
                        uploadedBy: x.name(attachment.uploaderId),
                        uploadedAt: attachment.createdAt,
                        size: formatBytes(attachment.size),
                        link: attachment.link,
                    }))
                ),
            ],
        },
    ];
};

const formatBytes = (bytes) => {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return null;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

// ---- The workbook -----------------------------------------------------------

/**
 * data: {
 *   mode: "job" | "unit", unit, timeZone, exportedAt, actorName, filters: [{ label, value }],
 *   jobs (plain opportunities, in order), users (Map id → name),
 *   history, quotes, versions, proposals, requotes, approvals, procurementJobs,
 *   purchaseOrders, requests (with attachments), siteVisits, documents
 * }
 * Documents and request attachments carry `link`, the file's address.
 */
export const buildWorkbook = (data) => {
    const timeZone = safeZone(data.timeZone);
    const order = new Map(data.jobs.map((o, i) => [o.id, i]));
    const numbers = new Map(data.jobs.map((o) => [o.id, o.number]));
    const x = {
        ...data,
        timeZone,
        number: (id) => numbers.get(id) ?? null,
        name: (id) => (id ? data.users.get(Number(id)) ?? `User ${id}` : null),
    };

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Prestige";
    workbook.created = data.exportedAt;

    // The job record.
    if (data.mode === "job") {
        const [opportunity] = data.jobs;
        addFieldSheet(
            workbook,
            "Summary",
            JOB_FIELDS.map((field) => ({ ...field, value: field.get(opportunity, x) })),
            timeZone,
            { sectioned: true }
        );
    } else {
        addTable(
            workbook,
            "Jobs",
            JOB_FIELDS.map((field) => ({ header: field.label, key: field.label, type: field.type, wrap: LONG_FIELDS.has(field.label) })),
            data.jobs.map((o) => Object.fromEntries(JOB_FIELDS.map((field) => [field.label, field.get(o, x)]))),
            timeZone
        );
    }

    // Everything hanging off it, grouped by job in the jobs' order (the queries
    // already return each job's rows oldest first; the sort is stable).
    for (const sheet of childSheets(x)) {
        const rows = [...sheet.rows].sort((a, b) => (order.get(a.opportunityId) ?? 0) - (order.get(b.opportunityId) ?? 0));
        if (data.mode === "job" && !rows.length) continue;
        addTable(workbook, sheet.name, [JOB_COLUMN, ...sheet.columns], rows, timeZone);
    }

    addFieldSheet(
        workbook,
        "Export info",
        [
            { label: "Exported", value: data.exportedAt, type: "datetime" },
            { label: "Exported by", value: data.actorName },
            { label: "Business unit", value: data.unit ? `${data.unit.name} (${data.unit.code})` : null },
            ...(data.filters ?? []),
            { label: "Jobs", value: data.jobs.length, type: "number" },
            { label: "Times are shown in", value: timeZone },
            { label: "Money", value: "Dollars. Values marked ex GST exclude GST; quote and proposal totals are as issued." },
            { label: "Files", value: "Uploaded files are not inside this workbook. The Documents sheet links to each one." },
        ],
        timeZone
    );

    return workbook;
};
