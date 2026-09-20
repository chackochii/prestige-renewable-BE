"use strict";

// Saved quote versions: a frozen snapshot of the quote as it stood when
// somebody issued it. The PDF is rebuilt from the snapshot on view, so the
// snapshot is all there is to keep — the live quote carries on being edited.
//
// The server owns the version number (unique per quote), so two people saving
// at the same moment cannot land on the same one.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.createTable("quote_versions", {
            id: { type: Sequelize.INTEGER, primaryKey: true, allowNull: false, autoIncrement: true },
            quote_id: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: { model: "quotes", key: "id" },
                onUpdate: "CASCADE",
                onDelete: "CASCADE",
            },
            opportunity_id: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: { model: "opportunities", key: "id" },
                onUpdate: "CASCADE",
                onDelete: "CASCADE",
            },
            version: { type: Sequelize.INTEGER, allowNull: false },
            quote_number: { type: Sequelize.STRING(40) },
            invoice_number: { type: Sequelize.STRING(40) }, // set when the version is invoiced
            grand_total: { type: Sequelize.DECIMAL(14, 2) },
            snapshot: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
            created_by_id: {
                type: Sequelize.INTEGER,
                allowNull: true,
                references: { model: "users", key: "id" },
                onUpdate: "CASCADE",
                onDelete: "SET NULL",
            },
            created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
            updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
        });
        await queryInterface.addIndex("quote_versions", ["opportunity_id", "created_at"]);
        await queryInterface.addIndex("quote_versions", ["quote_id", "version"], {
            name: "quote_versions_quote_id_version_uq",
            unique: true,
        });
    },

    async down(queryInterface) {
        await queryInterface.dropTable("quote_versions");
    },
};
