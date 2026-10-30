"use strict";

// Approvals exit logic (UAT, Oct 2026 — prestige-fe PR #18). Nothing moves a
// job out of approvals by itself any more: it is sent to Procurement by hand,
// can be put on hold, reopened from procurement or construction, sent back to
// estimation or sales from a rejected approval, and flagged for review when
// the quote changes under approvals already lodged.
//
//   opportunities.approval_hold      { reason, by, byId, at } while the job is On Hold at approvals
//   opportunities.approval_sent      { at, by, byId, conditionsReviewed } — the last Send to Procurement
//   opportunities.approval_reopened  { at, by, byId, reason, fromStage } — the last Reopen Approvals
//   opportunities.approval_review    { at, reason, lines } — Approval Review Needed (a revised quote)
//   opportunities.approval_return    { to, approval, reason, resets, … } while the job is back with
//                                     estimation or sales from a rejected approval
//   opportunities.lost_reason        why a job closed as lost (approval_refused | customer_withdrew | other)
//   purchase_orders.review_flag      { reason, at, by } — raised before the approvals were reopened;
//                                     held until it is marked reviewed

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        for (const column of ["approval_hold", "approval_sent", "approval_reopened", "approval_review", "approval_return"])
            await queryInterface.addColumn("opportunities", column, { type: Sequelize.JSONB, allowNull: true });
        await queryInterface.addColumn("opportunities", "lost_reason", { type: Sequelize.STRING(40), allowNull: true });
        await queryInterface.addColumn("purchase_orders", "review_flag", { type: Sequelize.JSONB, allowNull: true });
    },

    async down(queryInterface) {
        await queryInterface.removeColumn("purchase_orders", "review_flag");
        await queryInterface.removeColumn("opportunities", "lost_reason");
        for (const column of ["approval_return", "approval_review", "approval_reopened", "approval_sent", "approval_hold"])
            await queryInterface.removeColumn("opportunities", column);
    },
};
