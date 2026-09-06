"use strict";

// Lead qualification detail captured on the "New lead" form: BANT-style
// fields plus the next concrete action. estimated_value is the salesperson's
// early sizing — accepted_value stays the contracted outcome.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.addColumn("opportunities", "qualification", {
            type: Sequelize.STRING(20),
            allowNull: false,
            defaultValue: "qualified",
        });
        await queryInterface.addColumn("opportunities", "qualification_authority", {
            type: Sequelize.STRING,
            allowNull: true,
        });
        await queryInterface.addColumn("opportunities", "qualification_timing", {
            type: Sequelize.STRING,
            allowNull: true,
        });
        await queryInterface.addColumn("opportunities", "estimated_value", {
            type: Sequelize.DECIMAL(14, 2),
            allowNull: true,
        });
        await queryInterface.addColumn("opportunities", "next_action", {
            type: Sequelize.STRING,
            allowNull: true,
        });
        await queryInterface.addColumn("opportunities", "next_action_due_at", {
            type: Sequelize.DATEONLY,
            allowNull: true,
        });
    },

    async down(queryInterface) {
        await queryInterface.removeColumn("opportunities", "next_action_due_at");
        await queryInterface.removeColumn("opportunities", "next_action");
        await queryInterface.removeColumn("opportunities", "estimated_value");
        await queryInterface.removeColumn("opportunities", "qualification_timing");
        await queryInterface.removeColumn("opportunities", "qualification_authority");
        await queryInterface.removeColumn("opportunities", "qualification");
    },
};
