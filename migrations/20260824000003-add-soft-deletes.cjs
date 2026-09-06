"use strict";

// Soft deletes (Sequelize paranoid mode) for the business entities that must
// never be hard-deleted: users, referrers, opportunities.
const TABLES = ["users", "referrers", "opportunities"];

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        for (const table of TABLES) {
            await queryInterface.addColumn(table, "deleted_at", { type: Sequelize.DATE, allowNull: true });
        }

        // Unique constraints must only apply to live rows, otherwise a
        // soft-deleted user's email (or opportunity number) can never be
        // reused. Replace them with partial unique indexes.
        await queryInterface.removeConstraint("users", "users_email_key");
        await queryInterface.sequelize.query(
            "CREATE UNIQUE INDEX users_email_active_uq ON users (email) WHERE deleted_at IS NULL"
        );

        await queryInterface.removeConstraint("opportunities", "opportunities_number_key");
        await queryInterface.sequelize.query(
            "CREATE UNIQUE INDEX opportunities_number_active_uq ON opportunities (number) WHERE deleted_at IS NULL"
        );
    },

    async down(queryInterface) {
        // Fails if soft-deleted duplicates exist — resolve those before undoing.
        await queryInterface.sequelize.query("DROP INDEX IF EXISTS opportunities_number_active_uq");
        await queryInterface.addConstraint("opportunities", {
            fields: ["number"],
            type: "unique",
            name: "opportunities_number_key",
        });

        await queryInterface.sequelize.query("DROP INDEX IF EXISTS users_email_active_uq");
        await queryInterface.addConstraint("users", {
            fields: ["email"],
            type: "unique",
            name: "users_email_key",
        });

        for (const table of [...TABLES].reverse()) {
            await queryInterface.removeColumn(table, "deleted_at");
        }
    },
};
