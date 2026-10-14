"use strict";

// Quotes are generated, not just saved (Oct 2026). A quote is a draft while
// the estimator builds it, saving as they go; "generate" freezes it as the
// next version and locks it — nothing on a generated quote can be edited.
// To change anything they start a new quote, which opens a fresh draft
// pre-filled from the generated one (same rows: nothing is copied, the lock
// simply comes off). Generating that draft makes the next version.
//
//   status               draft | generated
//   generated_at         when the current version was generated
//   generated_version_id the version the quote is locked to
//
// Existing quotes: one with a version was issued, so it starts out generated
// (locked to its newest version) — the estimator opens a new quote to carry
// on, and nothing is lost since the draft keeps every row.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.addColumn("quotes", "status", { type: Sequelize.STRING(20), allowNull: false, defaultValue: "draft" });
        await queryInterface.addColumn("quotes", "generated_at", { type: Sequelize.DATE, allowNull: true });
        await queryInterface.addColumn("quotes", "generated_version_id", {
            type: Sequelize.INTEGER,
            allowNull: true,
            references: { model: "quote_versions", key: "id" },
            onUpdate: "CASCADE",
            onDelete: "SET NULL",
        });
        await queryInterface.sequelize.query(`
            UPDATE quotes q
            SET status = 'generated', generated_at = v.created_at, generated_version_id = v.id
            FROM (
                SELECT DISTINCT ON (quote_id) id, quote_id, created_at
                FROM quote_versions
                ORDER BY quote_id, version DESC, id DESC
            ) v
            WHERE v.quote_id = q.id
        `);
    },

    async down(queryInterface) {
        await queryInterface.removeColumn("quotes", "generated_version_id");
        await queryInterface.removeColumn("quotes", "generated_at");
        await queryInterface.removeColumn("quotes", "status");
    },
};
