"use strict";

const SUPERADMIN_EMAIL = process.env.SEED_SUPERADMIN_EMAIL || "superadmin@prestige.group";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        // sequelize-cli loads this file as CommonJS, so we use a dynamic import
        const { default: bcrypt } = await import("bcryptjs");
        const password = process.env.SEED_SUPERADMIN_PASSWORD || "ChangeMe@123";
        const passwordHash = await bcrypt.hash(password, 10);

        await queryInterface.bulkInsert("users", [
            {
                name: "Super Admin",
                email: SUPERADMIN_EMAIL,
                password: passwordHash,
                roles: "{ADM}", // Postgres array literal
                title: "System Administrator",
                status: "active",
                referrer_id: null,
                created_at: new Date(),
                updated_at: new Date(),
            },
        ]);
    },

    async down(queryInterface) {
        await queryInterface.bulkDelete("users", { email: SUPERADMIN_EMAIL });
    },
};
