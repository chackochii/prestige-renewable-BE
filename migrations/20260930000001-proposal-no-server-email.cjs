"use strict";

// Proposals are no longer emailed from the server: the app opens the sales
// rep's Gmail with the email and link ready, and the rep sends it themselves.
// So there is no delivery status to record. The recipient, subject and
// message stay, as the record of what the rep was given to send.

module.exports = {
    async up(queryInterface) {
        await queryInterface.removeColumn("proposals", "email_error");
        await queryInterface.removeColumn("proposals", "email_status");
    },

    async down(queryInterface, Sequelize) {
        await queryInterface.addColumn("proposals", "email_status", { type: Sequelize.STRING(20), allowNull: true });
        await queryInterface.addColumn("proposals", "email_error", { type: Sequelize.STRING(500), allowNull: true });
    },
};
