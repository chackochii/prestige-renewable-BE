"use strict";

// Indexes for the two shapes every opportunity list uses:
//
//   1. filter by business unit, order by updated_at  — the pipeline board, the
//      leads list, the home page. One composite index serves both the filter
//      and the sort, so the planner stops sorting the whole unit's rows.
//   2. ?search= against number / customer name — an iLike '%term%' cannot use a
//      btree index at all, because the wildcard is on the left. pg_trgm's GIN
//      index is the one thing that makes a contains-match indexable.
//
// Both are partial on deleted_at IS NULL: every read is paranoid-scoped, so
// soft-deleted rows only make the index bigger.
//
// At the row counts this database holds today the planner will still choose a
// sequential scan — these are in place for when it stops doing so, and cost
// nothing until then.

/** The columns ?search= matches, all with the same iLike '%term%' shape. */
const SEARCH_COLUMNS = ["number", "customer_legal_name", "customer_trading_name"];

module.exports = {
    async up(queryInterface) {
        await queryInterface.sequelize.query(
            `CREATE INDEX IF NOT EXISTS opportunities_unit_updated_idx
             ON opportunities (business_unit_id, updated_at DESC)
             WHERE deleted_at IS NULL`
        );

        // Needs privileges the application user may not hold on a managed
        // database. If it fails, the composite index above is still created and
        // search keeps working exactly as it does now — just unindexed.
        try {
            await queryInterface.sequelize.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
        } catch (err) {
            console.warn(`pg_trgm not enabled (${err.message}); skipping the search indexes.`);
            return;
        }

        for (const column of SEARCH_COLUMNS) {
            await queryInterface.sequelize.query(
                `CREATE INDEX IF NOT EXISTS opportunities_${column}_trgm_idx
                 ON opportunities USING gin (${column} gin_trgm_ops)
                 WHERE deleted_at IS NULL`
            );
        }
    },

    async down(queryInterface) {
        for (const column of SEARCH_COLUMNS)
            await queryInterface.sequelize.query(`DROP INDEX IF EXISTS opportunities_${column}_trgm_idx`);
        await queryInterface.sequelize.query("DROP INDEX IF EXISTS opportunities_unit_updated_idx");
        // pg_trgm is left installed: other tables may come to rely on it, and
        // dropping an extension is not the business of this migration.
    },
};
