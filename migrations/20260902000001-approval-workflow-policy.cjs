"use strict";

// Columns backing the Sydpro approval workflow policy
// (modules/opportunity/service/approvalPolicy.js):
//  - purchase_orders.created_by_id / approved_by_id / approved_at — a PO may
//    not be approved by its creator, so both sides must be recorded.
//  - variations.change_percent — price variations below 5% need SMM approval,
//    5% and above need BO + SMM.
// Also moves the approvals.owner_role default from the retired BOP code to
// its matrix successor BOM.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.addColumn("purchase_orders", "created_by_id", {
            type: Sequelize.INTEGER,
            allowNull: true,
            references: { model: "users", key: "id" },
            onDelete: "SET NULL",
        });
        await queryInterface.addColumn("purchase_orders", "approved_by_id", {
            type: Sequelize.INTEGER,
            allowNull: true,
            references: { model: "users", key: "id" },
            onDelete: "SET NULL",
        });
        await queryInterface.addColumn("purchase_orders", "approved_at", {
            type: Sequelize.DATE,
            allowNull: true,
        });
        await queryInterface.addColumn("variations", "change_percent", {
            type: Sequelize.DECIMAL(6, 2),
            allowNull: true,
        });
        await queryInterface.sequelize.query(
            "ALTER TABLE approvals ALTER COLUMN owner_role SET DEFAULT 'BOM'"
        );
    },

    async down(queryInterface) {
        await queryInterface.sequelize.query(
            "ALTER TABLE approvals ALTER COLUMN owner_role SET DEFAULT 'BOP'"
        );
        await queryInterface.removeColumn("variations", "change_percent");
        await queryInterface.removeColumn("purchase_orders", "approved_at");
        await queryInterface.removeColumn("purchase_orders", "approved_by_id");
        await queryInterface.removeColumn("purchase_orders", "created_by_id");
    },
};
