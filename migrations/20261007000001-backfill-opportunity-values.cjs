"use strict";

// Fills in what each job is worth, which nothing wrote until now: every
// dollar figure in the pipeline (Quotes totals, Home, board columns, the job
// header, referrer commission, the billing split) read $0 for real jobs.
//
//   estimated_value — the newest saved quote version's total without GST
//                     (quoteService.createVersion now keeps it current)
//   accepted_value  — the accepted proposal's version total without GST
//                     (proposalService.applyResponse now sets it on a yes)
//
// The pipeline counts these "ex GST", as its screens say. Without GST is the
// version total ÷ (1 + its GST rate), or the total itself for a no-GST quote;
// a version whose snapshot lacks its quote is taken as GST-exclusive at 10 %
// (quoteService.exGstTotalOf does the same in code).
//
// Existing values are overwritten: before this, only the demo seeder set
// either column, and it stored totals with GST. Jobs with no saved version or
// no accepted proposal are left as they are.

const EX_GST = (total, snapshot) => `
    ROUND(
        CASE
            WHEN ${snapshot} -> 'quote' ->> 'taxTreatment' = 'no_gst' THEN ${total}
            ELSE ${total} / (1 + COALESCE(NULLIF(${snapshot} -> 'quote' ->> 'gstRatePct', '')::numeric, 10) / 100)
        END, 2)`;

module.exports = {
    async up(queryInterface) {
        await queryInterface.sequelize.query(`
            UPDATE opportunities o
            SET estimated_value = ${EX_GST("v.grand_total", "v.snapshot")}
            FROM (
                SELECT DISTINCT ON (opportunity_id) opportunity_id, grand_total, snapshot
                FROM quote_versions
                WHERE grand_total IS NOT NULL
                ORDER BY opportunity_id, version DESC, id DESC
            ) v
            WHERE v.opportunity_id = o.id
        `);
        await queryInterface.sequelize.query(`
            UPDATE opportunities o
            SET accepted_value = ${EX_GST("a.total", "a.snapshot")}
            FROM (
                SELECT DISTINCT ON (p.opportunity_id) p.opportunity_id, COALESCE(v.grand_total, p.grand_total) AS total, v.snapshot
                FROM proposals p
                LEFT JOIN quote_versions v ON v.id = p.quote_version_id
                WHERE p.status = 'accepted'
                ORDER BY p.opportunity_id, p.version DESC, p.id DESC
            ) a
            WHERE a.opportunity_id = o.id AND a.total IS NOT NULL
        `);
    },

    // Data only: the values these columns held before (zero, or the demo
    // seeder's) cannot be told apart from the ones written here, so nothing is
    // undone — the columns are kept up to date by the services from now on.
    async down() {},
};
