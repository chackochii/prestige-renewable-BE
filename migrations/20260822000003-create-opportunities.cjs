"use strict";

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

        await queryInterface.createTable("opportunities", {
            id: {
                type: Sequelize.INTEGER,
                primaryKey: true,
                allowNull: false,
                autoIncrement: true,
            },
            number: { type: Sequelize.STRING(20), allowNull: false, unique: true },
            business_unit_id: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: { model: "business_units", key: "id" },
                onUpdate: "CASCADE",
                onDelete: "RESTRICT",
            },
            stage: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
            lifecycle: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "Active" },
            variation_pending: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
            margin_floor: { type: Sequelize.DECIMAL(5, 2) },

            lead_source: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "internal" },
            referrer_id: {
                type: Sequelize.INTEGER,
                allowNull: true,
                references: { model: "referrers", key: "id" },
                onUpdate: "CASCADE",
                onDelete: "SET NULL",
            },
            involvement_tier: { type: Sequelize.STRING(30), allowNull: true },

            customer_legal_name: { type: Sequelize.STRING },
            customer_trading_name: { type: Sequelize.STRING },
            customer_abn: { type: Sequelize.STRING(20) },
            customer_email: { type: Sequelize.STRING },
            customer_phone: { type: Sequelize.STRING },
            customer_billing_address: { type: Sequelize.STRING },

            site_line1: { type: Sequelize.STRING },
            site_suburb: { type: Sequelize.STRING },
            site_state: { type: Sequelize.STRING(10) },
            site_postcode: { type: Sequelize.STRING(10) },
            site_jurisdiction: { type: Sequelize.STRING(10) },
            site_contact: { type: Sequelize.STRING },
            site_access_notes: { type: Sequelize.TEXT },

            contact_name: { type: Sequelize.STRING },
            contact_role: { type: Sequelize.STRING },
            contact_email: { type: Sequelize.STRING },
            contact_phone: { type: Sequelize.STRING },

            energy_annual_kwh: { type: Sequelize.DECIMAL(14, 2), allowNull: true },
            energy_has_bills: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
            energy_notes: { type: Sequelize.TEXT },

            lead_owner_id: { ...userFk },
            estimator_id: { ...userFk },
            salesperson_id: { ...userFk },
            delivery_owner_id: { ...userFk },

            sla_started_at: { type: Sequelize.DATE },
            sla_due_at: { type: Sequelize.DATE },

            install_window_start: { type: Sequelize.DATEONLY },
            install_window_end: { type: Sequelize.DATEONLY },
            electrical_contractor: { type: Sequelize.STRING },
            civil_contractor: { type: Sequelize.STRING },

            accepted_value: { type: Sequelize.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
            feedback: { type: Sequelize.TEXT },
            notes: { type: Sequelize.TEXT },

            closure_checklist_complete: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
            closure_warranty_contact: { type: Sequelize.STRING },
            closure_future_engagement: { type: Sequelize.STRING },
            closed_at: { type: Sequelize.DATE },

            created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
            updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
        });

        await queryInterface.addIndex("opportunities", ["business_unit_id"]);
        await queryInterface.addIndex("opportunities", ["stage"]);
        await queryInterface.addIndex("opportunities", ["referrer_id"]);
        await queryInterface.addIndex("opportunities", ["lifecycle"]);
    },

    async down(queryInterface) {
        await queryInterface.dropTable("opportunities");
    },
};
