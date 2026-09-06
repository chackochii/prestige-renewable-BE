"use strict";

// 1. business_units.metadata — free-form JSONB so each unit can carry any
//    extra data it needs (industry-specific fields, branding, contacts, …)
//    without schema changes.
// 2. user_business_units.assigned_by_id — which administrator granted the
//    user access to the unit, set when the user is created/assigned.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.addColumn("business_units", "metadata", {
            type: Sequelize.JSONB,
            allowNull: false,
            defaultValue: {},
        });
        await queryInterface.addColumn("user_business_units", "assigned_by_id", {
            type: Sequelize.INTEGER,
            allowNull: true,
            references: { model: "users", key: "id" },
            onUpdate: "CASCADE",
            onDelete: "SET NULL",
        });
    },

    async down(queryInterface) {
        await queryInterface.removeColumn("user_business_units", "assigned_by_id");
        await queryInterface.removeColumn("business_units", "metadata");
    },
};
