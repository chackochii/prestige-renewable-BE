"use strict";

// Procurement & delivery (stage 6) after the Oct 2026 frontend changes
// (prestige-fe PRs #13/#14, "procurementChanges"):
//
//  - A BOQ line carries `inInventory` — whether we already hold the item, set
//    on the BOQ-vs-site tab. Lines not in inventory are what quotes are sought
//    for (the FE's "list for quotes" PDF). Existing lines get `false`.
//  - A price-variation approval is requested and decided through a
//    collaboration request of kind "approval" rather than on the procurement
//    page or the CL-13 tick, so each approval entry carries `requestId` — the
//    request it waits on or was decided by. Existing entries get `null`.
//  - The CL-13 answers `variationApproved` / `variationApprovedBy` are no
//    longer read (the approval is taken from the approvals themselves) and are
//    dropped from saved checklists.
//
// All of it lives in procurement_jobs' JSONB columns, so this is a data
// backfill, not a schema change. collaboration_requests.kind is a plain string
// column and already takes "approval".

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

module.exports = {
    async up(queryInterface) {
        const [rows] = await queryInterface.sequelize.query("SELECT id, boq, revisions, approvals, checklist FROM procurement_jobs");
        for (const row of rows) {
            const lines = (list) => (Array.isArray(list) ? list.map((line) => (isObject(line) && line.inInventory === undefined ? { ...line, inInventory: false } : line)) : list);
            const boq = lines(row.boq);
            const revisions = Array.isArray(row.revisions) ? row.revisions.map((revision) => (isObject(revision) ? { ...revision, lines: lines(revision.lines) } : revision)) : row.revisions;
            const approvals = Array.isArray(row.approvals) ? row.approvals.map((entry) => (isObject(entry) && entry.requestId === undefined ? { ...entry, requestId: null } : entry)) : row.approvals;
            const checklist = isObject(row.checklist) ? { ...row.checklist } : row.checklist;
            if (isObject(checklist?.po)) {
                const { variationApproved, variationApprovedBy, ...po } = checklist.po;
                void variationApproved;
                void variationApprovedBy;
                checklist.po = po;
            }
            await queryInterface.sequelize.query(
                "UPDATE procurement_jobs SET boq = :boq::jsonb, revisions = :revisions::jsonb, approvals = :approvals::jsonb, checklist = :checklist::jsonb WHERE id = :id",
                { replacements: { id: row.id, boq: JSON.stringify(boq), revisions: JSON.stringify(revisions), approvals: JSON.stringify(approvals), checklist: JSON.stringify(checklist) } }
            );
        }
    },

    async down(queryInterface) {
        // The added keys are harmless to older code, which ignores them; the
        // dropped CL-13 answers cannot be recovered and were never authoritative.
        const [rows] = await queryInterface.sequelize.query("SELECT id, boq, revisions, approvals FROM procurement_jobs");
        for (const row of rows) {
            const strip = (list) => (Array.isArray(list) ? list.map((line) => { if (!isObject(line)) return line; const { inInventory, ...rest } = line; void inInventory; return rest; }) : list);
            const boq = strip(row.boq);
            const revisions = Array.isArray(row.revisions) ? row.revisions.map((revision) => (isObject(revision) ? { ...revision, lines: strip(revision.lines) } : revision)) : row.revisions;
            const approvals = Array.isArray(row.approvals) ? row.approvals.map((entry) => { if (!isObject(entry)) return entry; const { requestId, ...rest } = entry; void requestId; return rest; }) : row.approvals;
            await queryInterface.sequelize.query(
                "UPDATE procurement_jobs SET boq = :boq::jsonb, revisions = :revisions::jsonb, approvals = :approvals::jsonb WHERE id = :id",
                { replacements: { id: row.id, boq: JSON.stringify(boq), revisions: JSON.stringify(revisions), approvals: JSON.stringify(approvals) } }
            );
        }
    },
};
