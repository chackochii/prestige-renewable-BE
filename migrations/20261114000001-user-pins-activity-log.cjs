"use strict";

// Users with PINs and the activity log (Nov 2026).
//
// 1. users: a PIN beside the password. An administrator issues a *temporary*
//    PIN when adding a team member; the person signs in with it once and must
//    set their own before anything else works (users.pin_is_temporary). A user
//    may be created with a PIN only, so the password becomes nullable — login
//    with a password keeps working exactly as before for everyone who has one.
// 2. activity_logs: who changed what, when, and from where (web, api, public
//    form, webhook, system). One row per change across every module — the
//    users screen, equipment and pricing, supplier credit, loans, projects,
//    jobs, lead assignments and quote approvals (modules/activity).

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.changeColumn("users", "password", { type: Sequelize.STRING, allowNull: true });
        await queryInterface.addColumn("users", "pin_hash", { type: Sequelize.STRING(60), allowNull: true });
        await queryInterface.addColumn("users", "pin_is_temporary", { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false });
        await queryInterface.addColumn("users", "pin_set_at", { type: Sequelize.DATE, allowNull: true });
        await queryInterface.addColumn("users", "pin_issued_by_id", {
            type: Sequelize.INTEGER,
            allowNull: true,
            references: { model: "users", key: "id" },
            onDelete: "SET NULL",
        });

        await queryInterface.createTable("activity_logs", {
            id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            business_unit_id: {
                type: Sequelize.INTEGER,
                allowNull: true,
                references: { model: "business_units", key: "id" },
                onDelete: "SET NULL",
            },
            actor_id: {
                type: Sequelize.INTEGER,
                allowNull: true,
                references: { model: "users", key: "id" },
                onDelete: "SET NULL",
            },
            actor_name: { type: Sequelize.STRING(255), allowNull: true }, // kept even if the user is deleted
            source: { type: Sequelize.STRING(30), allowNull: false, defaultValue: "web" }, // web | api | public | webhook | system | seed
            entity_type: { type: Sequelize.STRING(40), allowNull: false }, // user | equipment | supplier | lead | quote_approval | …
            entity_id: { type: Sequelize.STRING(40), allowNull: true },
            entity_label: { type: Sequelize.STRING(255), allowNull: true }, // e.g. "PRS-26-0008", "Jane Smith"
            action: { type: Sequelize.STRING(60), allowNull: false }, // created | updated | deleted | assigned | …
            changes: { type: Sequelize.JSONB, allowNull: true }, // { field: { from, to } }
            meta: { type: Sequelize.JSONB, allowNull: true },
            ip: { type: Sequelize.STRING(45), allowNull: true },
            user_agent: { type: Sequelize.STRING(300), allowNull: true },
            created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
        });
        await queryInterface.addIndex("activity_logs", ["business_unit_id", "created_at"], { name: "activity_logs_unit_created" });
        await queryInterface.addIndex("activity_logs", ["entity_type", "entity_id"], { name: "activity_logs_entity" });
        await queryInterface.addIndex("activity_logs", ["actor_id"], { name: "activity_logs_actor" });
    },

    async down(queryInterface, Sequelize) {
        await queryInterface.dropTable("activity_logs");
        await queryInterface.removeColumn("users", "pin_issued_by_id");
        await queryInterface.removeColumn("users", "pin_set_at");
        await queryInterface.removeColumn("users", "pin_is_temporary");
        await queryInterface.removeColumn("users", "pin_hash");
        // Rows created with a PIN only have no password; give them an unusable one so NOT NULL can come back.
        await queryInterface.sequelize.query("UPDATE users SET password = '!' WHERE password IS NULL");
        await queryInterface.changeColumn("users", "password", { type: Sequelize.STRING, allowNull: false });
    },
};
