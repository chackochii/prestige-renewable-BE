"use strict";

// Procurement & delivery (stage 6) connected to the pipeline.
//
// One procurement_jobs row per opportunity, created when the job enters the
// stage: the bill of quantities seeded from the accepted quote (and its
// revisions to the site figures), the supplier quotes received, the price
// variation approvals, the Green Deal job, and the Operations Coordinator's
// checklist answers (CL-11 BOQ vs site, CL-12 supplier quote, CL-13 PO
// release, CL-14 material receipt, CL-10 job creation) as JSON.
//
// The purchase_orders table (unused until now) gains what the stage records
// on an order: the BOQ lines it covers, when it went to the supplier, the
// delivery slot and who signed for it; orders start as drafts.

module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.createTable("procurement_jobs", {
            id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
            opportunity_id: {
                type: Sequelize.INTEGER,
                allowNull: false,
                unique: true,
                references: { model: "opportunities", key: "id" },
                onUpdate: "CASCADE",
                onDelete: "CASCADE",
            },
            // The current round's lines: [{ key, kind, item, brand, unit, proposalQty, siteQty,
            //   proposalUnitCost, quotedUnitCost, supplier, availability, leadTimeDays }]
            boq: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
            // Earlier rounds, oldest first: [{ round, at, byId, by, reason, lines }]
            revisions: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
            // [{ supplier, total, validUntil, receivedAt, note }]
            quotes: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
            // Price-variation approvals: [{ role, approverId, approver, status, requestedAt, decidedAt, note }]
            approvals: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
            // { created, jobId, createdAt, byId, by }
            green_deal: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
            // { boq: {...}, quote: {...}, po: {...}, receipt: {...}, jobCreation: {...} }
            checklist: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
            entered_at: { type: Sequelize.DATE, allowNull: true },
            created_at: { type: Sequelize.DATE, allowNull: false },
            updated_at: { type: Sequelize.DATE, allowNull: false },
        });

        await queryInterface.addColumn("purchase_orders", "lines", { type: Sequelize.JSONB, allowNull: false, defaultValue: [] });
        await queryInterface.addColumn("purchase_orders", "sent_at", { type: Sequelize.DATE, allowNull: true });
        await queryInterface.addColumn("purchase_orders", "scheduled_for", { type: Sequelize.DATEONLY, allowNull: true });
        await queryInterface.addColumn("purchase_orders", "received_by", { type: Sequelize.STRING(120), allowNull: true });
        await queryInterface.changeColumn("purchase_orders", "status", { type: Sequelize.STRING(20), allowNull: false, defaultValue: "draft" });
    },

    async down(queryInterface, Sequelize) {
        await queryInterface.changeColumn("purchase_orders", "status", { type: Sequelize.STRING(20), allowNull: false, defaultValue: "sent" });
        for (const column of ["received_by", "scheduled_for", "sent_at", "lines"]) await queryInterface.removeColumn("purchase_orders", column);
        await queryInterface.dropTable("procurement_jobs");
    },
};
