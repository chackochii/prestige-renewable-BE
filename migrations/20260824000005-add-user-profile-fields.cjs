"use strict";

// Completes the user profile: contact phone for staff and external
// contributors, and last_login_at for the auth phase / user admin UI.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.addColumn("users", "phone", { type: Sequelize.STRING(30), allowNull: true });
        await queryInterface.addColumn("users", "last_login_at", { type: Sequelize.DATE, allowNull: true });
    },

    async down(queryInterface) {
        await queryInterface.removeColumn("users", "last_login_at");
        await queryInterface.removeColumn("users", "phone");
    },
};
