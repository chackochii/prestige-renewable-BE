"use strict";

// Shared counters for the rate limiters (middleware/rateLimit.js). They used
// to live in each process's memory, so with N instances behind a load balancer
// every limit was effectively N times larger. One row per limiter + client
// (e.g. "login:203.0.113.7"); the window is judged by the database clock, so
// instances never disagree about when it ended. Expired rows are swept by the
// limiter itself.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.createTable("rate_limits", {
            key: { type: Sequelize.STRING(300), allowNull: false, primaryKey: true },
            count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
            reset_at: { type: Sequelize.DATE, allowNull: false },
        });
        await queryInterface.addIndex("rate_limits", ["reset_at"], { name: "rate_limits_reset_at_idx" });
    },

    async down(queryInterface) {
        await queryInterface.dropTable("rate_limits");
    },
};
