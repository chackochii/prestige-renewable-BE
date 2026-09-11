"use strict";

// Estimation stage (2) rework (Sep 2026):
//  - opportunities: the estimator's workflow state — did sales hand over the
//    minimum requirements (and the checklist of what arrived), is more client
//    input needed, the estimator's detailed checklist answers, and the
//    pre-site inspection / site-visit assignment.
//  - quotes / quote_items / quote_costs: the quote builder — one quote per
//    opportunity, priced line items from the catalog and additional costs
//    (fixed or % of items). Totals are derived, never stored.
//  - catalog_items: products the quote builder offers, each with its brands
//    and unit prices (AUD ex GST).

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
        const timestamps = {
            created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
            updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
        };
        const add = (name, spec) => queryInterface.addColumn("opportunities", name, spec);
        const nullableBool = () => ({ type: Sequelize.BOOLEAN, allowNull: true });

        // ---- Estimation workflow state --------------------------------------
        await add("estimation_requirements_received", nullableBool()); // null = not answered yet
        await add("estimation_requirements_checklist", { type: Sequelize.JSONB, allowNull: false, defaultValue: [] }); // checklist keys ticked
        await add("estimation_on_hold_reason", { type: Sequelize.TEXT, allowNull: true }); // what sales still owes
        await add("estimation_client_info_needed", nullableBool());
        await add("estimation_checklist_values", { type: Sequelize.JSONB, allowNull: false, defaultValue: {} }); // { key: answer }
        await add("estimation_pre_site_inspection_required", nullableBool());
        await add("estimation_site_visit_assignee_id", { ...userFk });
        await add("estimation_site_visit_completed", nullableBool());

        // ---- Quotes ---------------------------------------------------------
        await queryInterface.createTable("quotes", {
            id: { type: Sequelize.INTEGER, primaryKey: true, allowNull: false, autoIncrement: true },
            opportunity_id: {
                type: Sequelize.INTEGER,
                allowNull: false,
                unique: true,
                references: { model: "opportunities", key: "id" },
                onUpdate: "CASCADE",
                onDelete: "CASCADE",
            },
            quote_number: { type: Sequelize.STRING(40), allowNull: false },
            project: { type: Sequelize.STRING, allowNull: true },
            project_type: { type: Sequelize.STRING(40), allowNull: false, defaultValue: "Solar" },
            project_type_other: { type: Sequelize.STRING, allowNull: true },
            quote_date: { type: Sequelize.DATEONLY, allowNull: true },
            tax_treatment: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "exclusive" }, // exclusive | inclusive | no_gst
            gst_rate_pct: { type: Sequelize.DECIMAL(5, 2), allowNull: false, defaultValue: 10 },
            created_by_id: { ...userFk },
            ...timestamps,
        });

        await queryInterface.createTable("quote_items", {
            id: { type: Sequelize.INTEGER, primaryKey: true, allowNull: false, autoIncrement: true },
            quote_id: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: { model: "quotes", key: "id" },
                onUpdate: "CASCADE",
                onDelete: "CASCADE",
            },
            item_key: { type: Sequelize.STRING(100), allowNull: false }, // catalog key at the time
            item_name: { type: Sequelize.STRING, allowNull: false },
            brand: { type: Sequelize.STRING, allowNull: false },
            unit: { type: Sequelize.STRING(30), allowNull: true },
            quantity: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 1 },
            unit_price: { type: Sequelize.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
            discount_pct: { type: Sequelize.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
            sort_order: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
            ...timestamps,
        });
        await queryInterface.addIndex("quote_items", ["quote_id"]);

        await queryInterface.createTable("quote_costs", {
            id: { type: Sequelize.INTEGER, primaryKey: true, allowNull: false, autoIncrement: true },
            quote_id: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: { model: "quotes", key: "id" },
                onUpdate: "CASCADE",
                onDelete: "CASCADE",
            },
            cost_type: { type: Sequelize.STRING(50), allowNull: false },
            calc_type: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "fixed" }, // fixed | percentage
            value: { type: Sequelize.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
            description: { type: Sequelize.STRING(500), allowNull: true },
            sort_order: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
            ...timestamps,
        });
        await queryInterface.addIndex("quote_costs", ["quote_id"]);

        // ---- Product catalog ------------------------------------------------
        await queryInterface.createTable("catalog_items", {
            id: { type: Sequelize.INTEGER, primaryKey: true, allowNull: false, autoIncrement: true },
            key: { type: Sequelize.STRING(100), allowNull: false, unique: true },
            name: { type: Sequelize.STRING, allowNull: false },
            unit: { type: Sequelize.STRING(30), allowNull: false, defaultValue: "unit" },
            brands: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] }, // [{ name, unitPrice }]
            is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
            sort_order: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
            ...timestamps,
        });
    },

    async down(queryInterface) {
        await queryInterface.dropTable("catalog_items");
        await queryInterface.dropTable("quote_costs");
        await queryInterface.dropTable("quote_items");
        await queryInterface.dropTable("quotes");
        for (const col of [
            "estimation_site_visit_completed", "estimation_site_visit_assignee_id",
            "estimation_pre_site_inspection_required", "estimation_checklist_values",
            "estimation_client_info_needed", "estimation_on_hold_reason",
            "estimation_requirements_checklist", "estimation_requirements_received",
        ])
            await queryInterface.removeColumn("opportunities", col);
    },
};
