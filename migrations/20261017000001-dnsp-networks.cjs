"use strict";

// DNSP networks: the distribution networks the coordinator picks from on the
// DNSP application (CL-07 item 1, "Correct DNSP or network identified for the
// installation address"). They used to be a fixed list in the frontend; now
// the system administrator maintains them under Superadmin → DNSP networks.
// Starts with the networks the frontend had, grouped by state.
//
// A job keeps the network's name in its checklist answers, so renaming or
// removing a network here never changes a job already recorded against it.

const NETWORKS = [
    ["Ausgrid", "NSW"],
    ["Endeavour Energy", "NSW"],
    ["Essential Energy", "NSW"],
    ["Evoenergy", "ACT"],
    ["Energex", "QLD"],
    ["Ergon Energy", "QLD"],
    ["CitiPower", "VIC"],
    ["Powercor", "VIC"],
    ["Jemena", "VIC"],
    ["United Energy", "VIC"],
    ["AusNet Services", "VIC"],
    ["SA Power Networks", "SA"],
    ["TasNetworks", "TAS"],
    ["Western Power", "WA"],
    ["Horizon Power", "WA"],
    ["Power and Water", "NT"],
];

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.createTable("dnsp_networks", {
            id: { type: Sequelize.INTEGER, primaryKey: true, allowNull: false, autoIncrement: true },
            name: { type: Sequelize.STRING(100), allowNull: false, unique: true },
            state: { type: Sequelize.STRING(10), allowNull: true }, // NSW, VIC, ... — groups the dropdown
            is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
            sort_order: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
            created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
            updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
        });

        const now = new Date();
        await queryInterface.bulkInsert(
            "dnsp_networks",
            NETWORKS.map(([name, state], index) => ({
                name,
                state,
                is_active: true,
                sort_order: index,
                created_at: now,
                updated_at: now,
            }))
        );
    },

    async down(queryInterface) {
        await queryInterface.dropTable("dnsp_networks");
    },
};
