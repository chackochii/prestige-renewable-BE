"use strict";

// A password an administrator sets (adding the user, or resetting it) is
// temporary: the person signs in with it once and must then choose their own
// before the app lets them in (userService.loginUser → a password_setup token,
// POST /users/me/password).
//   users.password_is_temporary — true until the person sets their own
//   users.password_set_at       — when they last chose their own password
// Existing accounts keep the password they have (false).

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.addColumn("users", "password_is_temporary", { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false });
        await queryInterface.addColumn("users", "password_set_at", { type: Sequelize.DATE, allowNull: true });
    },

    async down(queryInterface) {
        await queryInterface.removeColumn("users", "password_set_at");
        await queryInterface.removeColumn("users", "password_is_temporary");
    },
};
