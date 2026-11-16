"use strict";

// A final Solar + BESS proposal is saved as a version of the job's quote, so
// it goes through the proposal stage the way a manual quote does (Senior Sales
// approval, the customer's link, acceptance, the job's value):
//   quote_versions.energy_proposal_id — the proposal a version was made from
//   energy_proposals.quote_version_id — the version a final proposal became
// Both nullable: manual versions have no proposal, drafts have no version.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.addColumn("quote_versions", "energy_proposal_id", {
            type: Sequelize.INTEGER,
            allowNull: true,
            references: { model: "energy_proposals", key: "id" },
            onUpdate: "CASCADE",
            onDelete: "SET NULL",
        });
        await queryInterface.addIndex("quote_versions", ["energy_proposal_id"], { name: "quote_versions_energy_proposal_id" });
        await queryInterface.addColumn("energy_proposals", "quote_version_id", {
            type: Sequelize.INTEGER,
            allowNull: true,
            references: { model: "quote_versions", key: "id" },
            onUpdate: "CASCADE",
            onDelete: "SET NULL",
        });
    },

    async down(queryInterface) {
        await queryInterface.removeColumn("energy_proposals", "quote_version_id");
        await queryInterface.removeIndex("quote_versions", "quote_versions_energy_proposal_id");
        await queryInterface.removeColumn("quote_versions", "energy_proposal_id");
    },
};
