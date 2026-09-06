"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        // Registry of navigable pages/modules. Adding a page later is an
        // insert, not a code change — the sidebar and the per-unit toggle
        // screen both read this table.
        await queryInterface.createTable("app_pages", {
            id: {
                type: Sequelize.INTEGER,
                primaryKey: true,
                allowNull: false,
                autoIncrement: true,
            },
            code: { type: Sequelize.STRING(30), allowNull: false, unique: true },
            label: { type: Sequelize.STRING, allowNull: false },
            path: { type: Sequelize.STRING(100), allowNull: false, unique: true },
            sort_order: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
            view_permission_code: { type: Sequelize.STRING(50) },
            is_system: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
            created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
            updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
        });

        // Per-unit page overrides. No row = enabled (new pages default on
        // everywhere); a row with enabled=false turns the page off for that unit.
        await queryInterface.createTable("business_unit_pages", {
            id: {
                type: Sequelize.INTEGER,
                primaryKey: true,
                allowNull: false,
                autoIncrement: true,
            },
            business_unit_id: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: { model: "business_units", key: "id" },
                onUpdate: "CASCADE",
                onDelete: "CASCADE",
            },
            page_id: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: { model: "app_pages", key: "id" },
                onUpdate: "CASCADE",
                onDelete: "CASCADE",
            },
            enabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
            created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
            updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
        });

        await queryInterface.addIndex("business_unit_pages", ["business_unit_id", "page_id"], {
            unique: true,
            name: "business_unit_pages_unit_id_page_id_uq",
        });
    },

    async down(queryInterface) {
        await queryInterface.dropTable("business_unit_pages");
        await queryInterface.dropTable("app_pages");
    },
};
