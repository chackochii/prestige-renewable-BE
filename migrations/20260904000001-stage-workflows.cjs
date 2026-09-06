"use strict";

// Stage workflows behind the pipeline screens (estimation → proposal →
// closure → approvals → procurement → site works → billing → handover):
//  - campaigns: marketing briefs that leads are attributed to
//  - opportunities: lead type, campaign link, per-stage working data kept as
//    JSONB (meetings, inspection pack, estimate notes, external quotes, job
//    baseline, service follow-up, post-work enquiries, cost reconciliation)
//    and the operational / financial completion flags
//  - estimates: verification sign-off
//  - proposals: customer rejection reason
//  - variations: recorded approvals (the ≥5% rule needs two sign-offs)
//  - approvals: owner_role widened to fit matrix codes such as SITEOM
//  - site_work_substages: sign-off, failure and assignment
//  - documents: external link, label, stage and mime type

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        const userFk = {
            type: Sequelize.INTEGER,
            allowNull: true,
            references: { model: "users", key: "id" },
            onUpdate: "CASCADE",
            onDelete: "SET NULL",
        };

        await queryInterface.createTable("campaigns", {
            id: { type: Sequelize.INTEGER, primaryKey: true, allowNull: false, autoIncrement: true },
            business_unit_id: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: { model: "business_units", key: "id" },
                onUpdate: "CASCADE",
                onDelete: "CASCADE",
            },
            name: { type: Sequelize.STRING, allowNull: false },
            channel: { type: Sequelize.STRING },
            audience: { type: Sequelize.STRING },
            objective: { type: Sequelize.STRING },
            budget: { type: Sequelize.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
            actual_spend: { type: Sequelize.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
            status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "draft" },
            owner_id: { ...userFk },
            approver_id: { ...userFk },
            approved_at: { type: Sequelize.DATE },
            start_date: { type: Sequelize.DATEONLY },
            end_date: { type: Sequelize.DATEONLY },
            created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
            updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
        });
        await queryInterface.addIndex("campaigns", ["business_unit_id"]);

        const jsonb = (defaultValue) => ({ type: Sequelize.JSONB, allowNull: false, defaultValue });
        await queryInterface.addColumn("opportunities", "lead_type", { type: Sequelize.STRING(20), allowNull: true });
        await queryInterface.addColumn("opportunities", "campaign_id", {
            type: Sequelize.INTEGER,
            allowNull: true,
            references: { model: "campaigns", key: "id" },
            onUpdate: "CASCADE",
            onDelete: "SET NULL",
        });
        await queryInterface.addColumn("opportunities", "operational_complete", {
            type: Sequelize.BOOLEAN,
            allowNull: false,
            defaultValue: false,
        });
        await queryInterface.addColumn("opportunities", "financial_complete", {
            type: Sequelize.BOOLEAN,
            allowNull: false,
            defaultValue: false,
        });
        await queryInterface.addColumn("opportunities", "meetings", jsonb([]));
        await queryInterface.addColumn("opportunities", "inspection", jsonb({}));
        await queryInterface.addColumn("opportunities", "estimate_notes", jsonb({}));
        await queryInterface.addColumn("opportunities", "external_quotes", jsonb([]));
        await queryInterface.addColumn("opportunities", "job_baseline", jsonb({}));
        await queryInterface.addColumn("opportunities", "service", jsonb({}));
        await queryInterface.addColumn("opportunities", "post_work_enquiries", jsonb([]));
        await queryInterface.addColumn("opportunities", "additional_costs", jsonb([]));
        await queryInterface.addColumn("opportunities", "site_works_meta", jsonb({}));
        await queryInterface.addColumn("opportunities", "labor_cost_final", {
            type: Sequelize.DECIMAL(14, 2),
            allowNull: true,
        });
        await queryInterface.addIndex("opportunities", ["campaign_id"]);

        await queryInterface.addColumn("estimates", "verified_by_id", { ...userFk });
        await queryInterface.addColumn("estimates", "verified_at", { type: Sequelize.DATE, allowNull: true });

        await queryInterface.addColumn("proposals", "rejection_reason", { type: Sequelize.TEXT, allowNull: true });

        await queryInterface.addColumn("variations", "approvals", jsonb([]));

        await queryInterface.changeColumn("approvals", "owner_role", {
            type: Sequelize.STRING(20),
            allowNull: false,
            defaultValue: "BOM",
        });

        await queryInterface.addColumn("site_work_substages", "defects", { type: Sequelize.TEXT, allowNull: true });
        await queryInterface.addColumn("site_work_substages", "signed_off_at", { type: Sequelize.DATE, allowNull: true });
        await queryInterface.addColumn("site_work_substages", "signed_off_by_id", { ...userFk });
        await queryInterface.addColumn("site_work_substages", "assigned_to_id", { ...userFk });
        await queryInterface.addColumn("site_work_substages", "sort_order", {
            type: Sequelize.INTEGER,
            allowNull: false,
            defaultValue: 0,
        });

        await queryInterface.addColumn("documents", "url", { type: Sequelize.STRING(1000), allowNull: true });
        await queryInterface.addColumn("documents", "label", { type: Sequelize.STRING(50), allowNull: true });
        await queryInterface.addColumn("documents", "stage", { type: Sequelize.INTEGER, allowNull: true });
        await queryInterface.addColumn("documents", "mime", { type: Sequelize.STRING(100), allowNull: true });
    },

    async down(queryInterface, Sequelize) {
        for (const col of ["mime", "stage", "label", "url"]) await queryInterface.removeColumn("documents", col);
        for (const col of ["sort_order", "assigned_to_id", "signed_off_by_id", "signed_off_at", "defects"])
            await queryInterface.removeColumn("site_work_substages", col);
        await queryInterface.changeColumn("approvals", "owner_role", {
            type: Sequelize.STRING(5),
            allowNull: false,
            defaultValue: "BOM",
        });
        await queryInterface.removeColumn("variations", "approvals");
        await queryInterface.removeColumn("proposals", "rejection_reason");
        await queryInterface.removeColumn("estimates", "verified_at");
        await queryInterface.removeColumn("estimates", "verified_by_id");
        for (const col of [
            "labor_cost_final", "site_works_meta", "additional_costs", "post_work_enquiries", "service",
            "job_baseline", "external_quotes", "estimate_notes", "inspection", "meetings",
            "financial_complete", "operational_complete", "campaign_id", "lead_type",
        ])
            await queryInterface.removeColumn("opportunities", col);
        await queryInterface.dropTable("campaigns");
    },
};
