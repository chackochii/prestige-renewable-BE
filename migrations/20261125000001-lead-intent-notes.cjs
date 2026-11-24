"use strict";

// Genuine interest as notes (Nov 2026). The lead checklist's "Genuine
// interest" row was a tick box; sales now write down what the customer said
// that shows they mean to proceed.
//   opportunities.customer_intent_notes   the notes, null = none written
// customer_intent_confirmed stays: the form sets it while there are notes,
// and a lead ticked before the notes existed stays confirmed.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.addColumn("opportunities", "customer_intent_notes", { type: Sequelize.TEXT, allowNull: true });
    },

    async down(queryInterface) {
        await queryInterface.removeColumn("opportunities", "customer_intent_notes");
    },
};
