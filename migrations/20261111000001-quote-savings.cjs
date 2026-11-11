"use strict";

// Savings and payback on a quote (Nov 2026). What the system is expected to
// save the customer, so the proposal can show when it pays for itself. The
// payback, the yearly return and the lifetime figures are worked out by the
// client from these and the quote's total — never stored.
//
//   quotes.annual_savings        $ a year the system saves (incl. GST), null = not estimated
//   quotes.current_annual_bill   $ a year the customer pays for electricity today, null = not known
//   quotes.savings_basis         how the savings were worked out, in words the customer reads
//
// "Quote from bill" fills all three from the customer's electricity bill;
// the estimator can type or change them on any draft.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.addColumn("quotes", "annual_savings", { type: Sequelize.DECIMAL(12, 2), allowNull: true });
        await queryInterface.addColumn("quotes", "current_annual_bill", { type: Sequelize.DECIMAL(12, 2), allowNull: true });
        await queryInterface.addColumn("quotes", "savings_basis", { type: Sequelize.TEXT, allowNull: true });
    },

    async down(queryInterface) {
        await queryInterface.removeColumn("quotes", "savings_basis");
        await queryInterface.removeColumn("quotes", "current_annual_bill");
        await queryInterface.removeColumn("quotes", "annual_savings");
    },
};
