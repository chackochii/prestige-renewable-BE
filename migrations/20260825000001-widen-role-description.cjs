"use strict";

// Role descriptions carry the full responsibility text from the client's
// role model, which can exceed varchar(255).

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface) {
        await queryInterface.sequelize.query("ALTER TABLE roles ALTER COLUMN description TYPE text");
    },

    async down(queryInterface) {
        await queryInterface.sequelize.query(
            "ALTER TABLE roles ALTER COLUMN description TYPE varchar(255) USING left(description, 255)"
        );
    },
};
