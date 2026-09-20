"use strict";

// "Did the client have to be contacted for the mandatory details?" is a
// question on the lead checklist, and an unanswered question is not a "no" —
// the column becomes nullable so "not answered yet" is a state the record can
// hold, and the checklist can insist on an answer before handover.
//
// Rows already saved keep the false they were given; nothing is guessed on
// their behalf.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.changeColumn("opportunities", "needs_client_contact", {
            type: Sequelize.BOOLEAN,
            allowNull: true,
            defaultValue: null,
        });
    },

    async down(queryInterface, Sequelize) {
        await queryInterface.sequelize.query(
            "UPDATE opportunities SET needs_client_contact = false WHERE needs_client_contact IS NULL"
        );
        await queryInterface.changeColumn("opportunities", "needs_client_contact", {
            type: Sequelize.BOOLEAN,
            allowNull: false,
            defaultValue: false,
        });
    },
};
