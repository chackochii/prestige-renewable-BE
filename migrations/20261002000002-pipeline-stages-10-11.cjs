"use strict";

// The pipeline now runs to stage 11, named for the process chart: 9 Warranty
// registration, 10 Referrals & feedback, 11 DLP / O&M (prestige-fe
// constants/stages.js). Every unit that ran the old last stage (9) runs the
// two new ones after it, with SLA days for them where none are set — a job
// reaching warranty must have somewhere to go next.

module.exports = {
    async up(queryInterface) {
        await queryInterface.sequelize.query(`
            UPDATE business_units
               SET enabled_stages = (
                       SELECT jsonb_agg(stage ORDER BY stage)
                         FROM (
                               SELECT DISTINCT (value)::int AS stage FROM jsonb_array_elements(enabled_stages)
                               UNION SELECT 10 UNION SELECT 11
                              ) stages
                   )
             WHERE enabled_stages @> '[9]'::jsonb
        `);
        await queryInterface.sequelize.query(`
            UPDATE business_units
               SET sla_days = COALESCE(sla_days, '{}'::jsonb)
                              || CASE WHEN sla_days ? '10' THEN '{}'::jsonb ELSE '{"10": 14}'::jsonb END
                              || CASE WHEN sla_days ? '11' THEN '{}'::jsonb ELSE '{"11": 365}'::jsonb END
        `);
    },

    async down(queryInterface) {
        await queryInterface.sequelize.query(`
            UPDATE business_units
               SET enabled_stages = (
                       SELECT COALESCE(jsonb_agg(stage ORDER BY stage), '[]'::jsonb)
                         FROM (SELECT DISTINCT (value)::int AS stage FROM jsonb_array_elements(enabled_stages)) stages
                        WHERE stage <= 9
                   ),
                   sla_days = (sla_days - '10') - '11'
        `);
    },
};
