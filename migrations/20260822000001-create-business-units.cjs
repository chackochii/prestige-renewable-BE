"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.createTable("business_units", {
            id: {
                type: Sequelize.INTEGER,
                primaryKey: true,
                allowNull: false,
                autoIncrement: true,
            },
            code: { type: Sequelize.STRING(10), allowNull: false, unique: true },
            name: { type: Sequelize.STRING, allowNull: false },
            legal_name: { type: Sequelize.STRING },
            status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "configured" },
            timezone: { type: Sequelize.STRING, allowNull: false, defaultValue: "Australia/Sydney" },
            margin_floor: { type: Sequelize.DECIMAL(5, 2), allowNull: false, defaultValue: 15 },
            billing_split: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
            commission_tiers: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
            sla_days: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
            created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
            updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
        });
    },

    async down(queryInterface) {
        await queryInterface.dropTable("business_units");
    },
};
