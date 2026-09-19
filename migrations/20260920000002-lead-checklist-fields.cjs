"use strict";

// The lead checklist (Sep 2026): what sales must confirm with the customer
// before a lead can be marked a potential client and handed to estimation.
//
// Mandatory rows live as their own columns — they gate the handover and are
// reported on. The optional estimation-input rows travel in one JSONB blob
// (estimation_input): they never blocked the lead, and estimation collects
// whatever sales left blank (see modules/opportunity/service/estimationService).
//
// The last three columns carry the "lead details changed" notice: sales edits
// a lead after handover, the estimator is told, and clears it once read.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        const add = (name, spec) => queryInterface.addColumn("opportunities", name, spec);
        const text = () => ({ type: Sequelize.TEXT });
        const short = (length = 20) => ({ type: Sequelize.STRING(length) });

        // ---- Customer -------------------------------------------------------
        await add("customer_first_name", { type: Sequelize.STRING(100) });
        await add("customer_last_name", { type: Sequelize.STRING(100) });
        await add("preferred_language", short(40)); // blank = English
        await add("billing_same_as_site", short(3)); // yes | no
        await add("customer_comments", text()); // initial requirements in their words
        await add("customer_intent_confirmed", { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false });
        await add("customer_budget", { type: Sequelize.DECIMAL(12, 2) });
        await add("business_offers", text()); // what was offered to win the job

        // ---- Property & service --------------------------------------------
        await add("service_requirement", short(20)); // solar | battery | both
        await add("property_storeys", short(10)); // single | double
        await add("roof_type", short(20)); // tin | tile | colorbond
        await add("electrical_phase", short(10)); // 1_phase | 3_phase

        // ---- Money, site and timing ----------------------------------------
        await add("finance_assistance", short(10)); // yes | no
        await add("finance_notes", text());
        await add("site_requirements_none", { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false });
        await add("site_specific_requirements", text());
        await add("preferred_install_timeframe", short(20));
        await add("preferred_install_location", { type: Sequelize.STRING(255) });

        // ---- The optional rows estimation inherits --------------------------
        await add("estimation_input", { type: Sequelize.JSONB, allowNull: false, defaultValue: {} });
        await add("estimation_inputs_accepted_at", { type: Sequelize.DATE });
        await add("estimation_inputs_accepted_by_id", {
            type: Sequelize.INTEGER,
            references: { model: "users", key: "id" },
            onUpdate: "CASCADE",
            onDelete: "SET NULL",
        });

        // ---- "Lead details changed" notice ----------------------------------
        await add("lead_edited_at", { type: Sequelize.DATE }); // last edit after handover
        await add("lead_change_summary", text());
        await add("lead_change_acknowledged_at", { type: Sequelize.DATE });
    },

    async down(queryInterface) {
        const drop = (name) => queryInterface.removeColumn("opportunities", name);
        for (const column of [
            "lead_change_acknowledged_at",
            "lead_change_summary",
            "lead_edited_at",
            "estimation_inputs_accepted_by_id",
            "estimation_inputs_accepted_at",
            "estimation_input",
            "preferred_install_location",
            "preferred_install_timeframe",
            "site_specific_requirements",
            "site_requirements_none",
            "finance_notes",
            "finance_assistance",
            "electrical_phase",
            "roof_type",
            "property_storeys",
            "service_requirement",
            "business_offers",
            "customer_budget",
            "customer_intent_confirmed",
            "customer_comments",
            "billing_same_as_site",
            "preferred_language",
            "customer_last_name",
            "customer_first_name",
        ])
            await drop(column);
    },
};
