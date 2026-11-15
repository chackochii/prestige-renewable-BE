"use strict";

// Projects for the jobs signed before projects existed (Nov 2026).
//
// From now on a project is opened when the customer accepts the proposal
// (projectService.ensureProjectFor). Jobs that were already past that point —
// at Approvals (stage 5) or later — get one here, so Project Status starts
// with every signed job rather than empty. Numbered per unit in the order the
// jobs were created: <UNIT>-PRJ-<YY>-0001.
//
// The statuses are read off the pipeline stage the job is at:
//   5 approvals · 6 procurement · 7 installing · 8 invoiced · 9–11 completed
//   lifecycle Lost → cancelled, Closed → completed
// Payment type is "loan" when sales recorded finance assistance, else "cash".
// Rows are marked "[backfill]" in their notes so the down step removes only them.

const MARK = "[backfill] Opened from the job's pipeline stage when project tracking was introduced.";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface) {
        const year = String(new Date().getFullYear()).slice(-2);
        await queryInterface.sequelize.query(
            `INSERT INTO projects (
                 opportunity_id, business_unit_id, code, payment_type, status,
                 installation_status, installation_progress_pct, procurement_status,
                 assigned_rep_id, operations_owner_id, signed_at, expected_install_date, notes, created_at, updated_at)
             SELECT o.id, o.business_unit_id,
                    u.code || '-PRJ-' || :year || '-' || LPAD((COALESCE(taken.n, 0) + ROW_NUMBER() OVER (PARTITION BY o.business_unit_id ORDER BY o.created_at, o.id))::text, 4, '0'),
                    CASE WHEN o.finance_assistance = 'yes' THEN 'loan' ELSE 'cash' END,
                    CASE
                        WHEN o.lifecycle = 'Lost' THEN 'cancelled'
                        WHEN o.lifecycle = 'Closed' OR o.stage >= 9 THEN 'completed'
                        WHEN o.stage = 8 THEN 'invoiced'
                        WHEN o.stage = 7 THEN 'installing'
                        WHEN o.stage = 6 THEN 'procurement'
                        ELSE 'approvals'
                    END,
                    CASE WHEN o.stage >= 8 THEN 'completed' WHEN o.stage = 7 THEN 'in_progress' ELSE 'not_started' END,
                    CASE WHEN o.stage >= 8 THEN 100 ELSE 0 END,
                    CASE WHEN o.stage >= 7 THEN 'complete' WHEN o.stage = 6 THEN 'in_progress' ELSE 'not_started' END,
                    o.salesperson_id,
                    COALESCE(o.operational_coordinator_id, o.delivery_owner_id),
                    COALESCE((SELECT MAX(p.accepted_at) FROM proposals p WHERE p.opportunity_id = o.id AND p.status = 'accepted'), o.updated_at),
                    o.install_window_start,
                    :mark, NOW(), NOW()
             FROM opportunities o
             JOIN business_units u ON u.id = o.business_unit_id
             LEFT JOIN (
                 SELECT business_unit_id, COUNT(*) AS n FROM projects WHERE code LIKE '%-PRJ-' || :year || '-%' GROUP BY business_unit_id
             ) taken ON taken.business_unit_id = o.business_unit_id
             WHERE o.deleted_at IS NULL
               AND o.stage >= 5
               AND NOT EXISTS (SELECT 1 FROM projects x WHERE x.opportunity_id = o.id)`,
            { replacements: { year, mark: MARK } }
        );
    },

    async down(queryInterface) {
        await queryInterface.sequelize.query("DELETE FROM projects WHERE notes = :mark", { replacements: { mark: MARK } });
    },
};
