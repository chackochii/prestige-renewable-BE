"use strict";

// UAT changes (Oct 2026) the frontend now relies on:
//
//   opportunities.service_requirement  any of solar, battery, ev, other, ticked
//                                       as checkboxes and stored as a list
//                                       ("solar,battery,ev") — too long for the
//                                       old 20 characters. "both" stays readable
//                                       on the leads saved before.
//   opportunities.referrer_name        the referrer as sales typed it. A lead can
//                                       name a referrer who is not registered;
//                                       referrer_id still links the ones who are.
//   opportunities.custom_approval_types approvals the unit's catalogue does not
//                                       have, added to this job only:
//                                       [{ key, label }].
//   quote_costs.kind                   cost | rebate | discount — the quote
//                                       builder's section. New lines start with
//                                       no cost type, so the type can no longer
//                                       say which section a line is in. Existing
//                                       lines are sorted by their type, the way
//                                       the screen read them until now.
//   quotes.project_type                nullable, no default: the estimator picks
//                                       it ("Select from options"). Quotes
//                                       already saved keep theirs.

const REBATE_TYPES = ["Rebate", "STC", "VEEC / ESC", "Federal battery rebate", "State rebate", "Other rebate"];
const DISCOUNT_TYPES = ["Discount", "Customer discount", "Business owner discount", "Promotional", "Other discount"];

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.changeColumn("opportunities", "service_requirement", { type: Sequelize.STRING(60), allowNull: true });
        await queryInterface.addColumn("opportunities", "referrer_name", { type: Sequelize.STRING(255), allowNull: true });
        await queryInterface.addColumn("opportunities", "custom_approval_types", { type: Sequelize.JSONB, allowNull: false, defaultValue: [] });

        await queryInterface.addColumn("quote_costs", "kind", { type: Sequelize.STRING(20), allowNull: false, defaultValue: "cost" });
        await queryInterface.sequelize.query(
            `UPDATE quote_costs SET kind = CASE
                WHEN cost_type IN (:rebates) THEN 'rebate'
                WHEN cost_type IN (:discounts) THEN 'discount'
                ELSE 'cost' END`,
            { replacements: { rebates: REBATE_TYPES, discounts: DISCOUNT_TYPES } }
        );

        await queryInterface.changeColumn("quotes", "project_type", { type: Sequelize.STRING(40), allowNull: true, defaultValue: null });
    },

    async down(queryInterface, Sequelize) {
        await queryInterface.sequelize.query("UPDATE quotes SET project_type = 'Solar' WHERE project_type IS NULL OR project_type = 'EV'");
        await queryInterface.changeColumn("quotes", "project_type", { type: Sequelize.STRING(40), allowNull: false, defaultValue: "Solar" });

        await queryInterface.removeColumn("quote_costs", "kind");

        await queryInterface.removeColumn("opportunities", "custom_approval_types");
        await queryInterface.removeColumn("opportunities", "referrer_name");
        // Back to one of solar, battery or both; anything else is dropped.
        await queryInterface.sequelize.query(`
            UPDATE opportunities SET service_requirement = CASE
                WHEN service_requirement IN ('solar', 'battery', 'both') THEN service_requirement
                WHEN service_requirement LIKE '%solar%' AND service_requirement LIKE '%battery%' THEN 'both'
                WHEN service_requirement LIKE '%solar%' THEN 'solar'
                WHEN service_requirement LIKE '%battery%' THEN 'battery'
                ELSE NULL END
            WHERE service_requirement IS NOT NULL
        `);
        await queryInterface.changeColumn("opportunities", "service_requirement", { type: Sequelize.STRING(20), allowNull: true });
    },
};
