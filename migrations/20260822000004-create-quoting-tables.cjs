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

        await queryInterface.createTable("estimates", {
            id: { ...id },
            opportunity_id: { ...opportunityFk },
            version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
            issued: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
            issued_at: { type: Sequelize.DATE },
            ...timestamps,
        });
        await queryInterface.addIndex("estimates", ["opportunity_id", "version"], {
            unique: true,
            name: "estimates_opportunity_id_version_uq",
        });

        await queryInterface.createTable("estimate_options", {
            id: { ...id },
            estimate_id: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: { model: "estimates", key: "id" },
                onUpdate: "CASCADE",
                onDelete: "CASCADE",
            },
            name: { type: Sequelize.STRING },
            brand: { type: Sequelize.STRING },
            product: { type: Sequelize.STRING },
            capacity_kw: { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
            capacity_kwh: { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
            cost_ex: { type: Sequelize.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
            price_ex: { type: Sequelize.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
            margin: { type: Sequelize.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
            annual_saving: { type: Sequelize.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
            payback_years: { type: Sequelize.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
            selected: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
            ...timestamps,
        });
        await queryInterface.addIndex("estimate_options", ["estimate_id"]);

        await queryInterface.createTable("proposals", {
            id: { ...id },
            opportunity_id: { ...opportunityFk },
            number: { type: Sequelize.STRING(30) },
            version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
            estimate_version: { type: Sequelize.INTEGER },
            status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "draft" },
            price_ex: { type: Sequelize.DECIMAL(14, 2) },
            margin: { type: Sequelize.DECIMAL(5, 2) },
            issued_at: { type: Sequelize.DATE },
            presented_at: { type: Sequelize.DATE },
            accepted_at: { type: Sequelize.DATE },
            director_approval_status: { type: Sequelize.STRING(20), allowNull: true },
            director_approval_by_id: {
                type: Sequelize.INTEGER,
                allowNull: true,
                references: { model: "users", key: "id" },
                onUpdate: "CASCADE",
                onDelete: "SET NULL",
            },
            director_approval_at: { type: Sequelize.DATE },
            director_approval_note: { type: Sequelize.TEXT },
            signed_doc_name: { type: Sequelize.STRING },
            ...timestamps,
        });
        await queryInterface.addIndex("proposals", ["opportunity_id", "version"], {
            unique: true,
            name: "proposals_opportunity_id_version_uq",
        });

        await queryInterface.createTable("variations", {
            id: { ...id },
            opportunity_id: { ...opportunityFk },
            reason: { type: Sequelize.TEXT, allowNull: false },
            status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "re-estimate" },
            created_by_id: {
                type: Sequelize.INTEGER,
                allowNull: true,
                references: { model: "users", key: "id" },
                onUpdate: "CASCADE",
                onDelete: "SET NULL",
            },
            ...timestamps,
        });
        await queryInterface.addIndex("variations", ["opportunity_id"]);
    },

    async down(queryInterface) {
        await queryInterface.dropTable("variations");
        await queryInterface.dropTable("proposals");
        await queryInterface.dropTable("estimate_options");
        await queryInterface.dropTable("estimates");
    },
};
