"use strict";

// Lead capture rework (Sep 2026): the mandatory checklist the salesperson
// completes before deciding whether a lead is a potential client, the
// client-visit hand-off to an operational coordinator, and a job-history log
// of notes and system events on each opportunity.
//
//  - opportunities: checklist fields (map link, contact attempts, source
//    details, owner discount, client-visit request, custom fields,
//    not-potential reason), the reason a lead is left without a salesperson,
//    and the operational coordinator assignment.
//  - opportunity_history: manual notes + system events (assignments), newest
//    first on the History tab.
//  - qualification now defaults to "nurture": a lead only becomes "qualified"
//    through the Potential decision once the checklist is complete.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        const add = (name, spec) => queryInterface.addColumn("opportunities", name, spec);
        const bool = () => ({ type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false });
        const jsonbList = () => ({ type: Sequelize.JSONB, allowNull: false, defaultValue: [] });

        await add("site_map_url", { type: Sequelize.STRING(1000), allowNull: true });
        await add("needs_client_contact", bool());
        await add("contact_attempts", jsonbList()); // [{ method, contactedAt, reached, reason }]
        await add("lead_source_details", { type: Sequelize.STRING(500), allowNull: true });
        await add("has_owner_discount", bool());
        await add("owner_discount_name", { type: Sequelize.STRING, allowNull: true });
        await add("owner_discount_amount", { type: Sequelize.DECIMAL(14, 2), allowNull: true });
        await add("unassigned_reason", { type: Sequelize.TEXT, allowNull: true });
        await add("needs_client_visit", bool());
        await add("client_visit_reason", { type: Sequelize.TEXT, allowNull: true });
        await add("operational_coordinator_id", {
            type: Sequelize.INTEGER,
            allowNull: true,
            references: { model: "users", key: "id" },
            onUpdate: "CASCADE",
            onDelete: "SET NULL",
        });
        await add("custom_fields", jsonbList()); // [{ label, value }]
        await add("not_potential_reason", { type: Sequelize.TEXT, allowNull: true });

        await queryInterface.changeColumn("opportunities", "qualification", {
            type: Sequelize.STRING(20),
            allowNull: false,
            defaultValue: "nurture",
        });

        await queryInterface.createTable("opportunity_history", {
            id: { type: Sequelize.INTEGER, primaryKey: true, allowNull: false, autoIncrement: true },
            opportunity_id: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: { model: "opportunities", key: "id" },
                onUpdate: "CASCADE",
                onDelete: "CASCADE",
            },
            author_id: {
                type: Sequelize.INTEGER,
                allowNull: true,
                references: { model: "users", key: "id" },
                onUpdate: "CASCADE",
                onDelete: "SET NULL",
            },
            kind: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "note" }, // note | system
            note: { type: Sequelize.TEXT, allowNull: false },
            created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
            updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
        });
        await queryInterface.addIndex("opportunity_history", ["opportunity_id", "created_at"]);
    },

    async down(queryInterface, Sequelize) {
        await queryInterface.dropTable("opportunity_history");
        await queryInterface.changeColumn("opportunities", "qualification", {
            type: Sequelize.STRING(20),
            allowNull: false,
            defaultValue: "qualified",
        });
        for (const col of [
            "not_potential_reason", "custom_fields", "operational_coordinator_id", "client_visit_reason",
            "needs_client_visit", "unassigned_reason", "owner_discount_amount", "owner_discount_name",
            "has_owner_discount", "lead_source_details", "contact_attempts", "needs_client_contact", "site_map_url",
        ])
            await queryInterface.removeColumn("opportunities", col);
    },
};
