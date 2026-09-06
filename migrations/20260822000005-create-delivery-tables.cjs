"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        const id = {
            type: Sequelize.INTEGER,
            primaryKey: true,
            allowNull: false,
            autoIncrement: true,
        };
        const opportunityFk = {
            type: Sequelize.INTEGER,
            allowNull: false,
            references: { model: "opportunities", key: "id" },
            onUpdate: "CASCADE",
            onDelete: "CASCADE",
        };
        const timestamps = {
            created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
            updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
        };

        await queryInterface.createTable("approvals", {
            id: { ...id },
            opportunity_id: { ...opportunityFk },
            type: { type: Sequelize.STRING(20), allowNull: false },
            label: { type: Sequelize.STRING },
            required: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
            status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "Not Started" },
            owner_role: { type: Sequelize.STRING(5), allowNull: false, defaultValue: "BOP" },
            submitted_at: { type: Sequelize.DATE },
            outcome_at: { type: Sequelize.DATE },
            notes: { type: Sequelize.TEXT },
            document_name: { type: Sequelize.STRING },
            ...timestamps,
        });
        await queryInterface.addIndex("approvals", ["opportunity_id", "type"], {
            unique: true,
            name: "approvals_opportunity_id_type_uq",
        });

        await queryInterface.createTable("purchase_orders", {
            id: { ...id },
            opportunity_id: { ...opportunityFk },
            ref: { type: Sequelize.STRING, allowNull: false },
            supplier: { type: Sequelize.STRING },
            items: { type: Sequelize.TEXT },
            amount: { type: Sequelize.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
            eta: { type: Sequelize.DATEONLY },
            status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "sent" },
            confirmed_at: { type: Sequelize.DATE },
            delivered_at: { type: Sequelize.DATE },
            delivery_evidence: { type: Sequelize.STRING },
            confirming_user_id: {
                type: Sequelize.INTEGER,
                allowNull: true,
                references: { model: "users", key: "id" },
                onUpdate: "CASCADE",
                onDelete: "SET NULL",
            },
            ...timestamps,
        });
        await queryInterface.addIndex("purchase_orders", ["opportunity_id"]);

        await queryInterface.createTable("site_work_substages", {
            id: { ...id },
            opportunity_id: { ...opportunityFk },
            key: { type: Sequelize.STRING(5), allowNull: false },
            label: { type: Sequelize.STRING },
            status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "not_started" },
            checklist: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
            ...timestamps,
        });
        await queryInterface.addIndex("site_work_substages", ["opportunity_id", "key"], {
            unique: true,
            name: "site_work_substages_opportunity_id_key_uq",
        });

        await queryInterface.createTable("rebates", {
            id: { ...id },
            opportunity_id: { ...opportunityFk },
            type: { type: Sequelize.STRING, allowNull: false },
            value: { type: Sequelize.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
            status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "Not lodged" },
            lodged_at: { type: Sequelize.DATE },
            reference: { type: Sequelize.STRING },
            ...timestamps,
        });
        await queryInterface.addIndex("rebates", ["opportunity_id"]);
    },

    async down(queryInterface) {
        await queryInterface.dropTable("rebates");
        await queryInterface.dropTable("site_work_substages");
        await queryInterface.dropTable("purchase_orders");
        await queryInterface.dropTable("approvals");
    },
};
