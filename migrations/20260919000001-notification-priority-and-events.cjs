"use strict";

// In-app notifications gain an event type and a priority (Sep 2026):
//  - notifications.event: which happening produced the row (assignment,
//    stage change, SLA breach …) so the inbox can group and filter.
//  - notifications.priority: high | medium | low. The default per event lives
//    in code; a business unit may override it (see below).
//  - notifications.dedupe_key: lets a repeatable check (the SLA watcher runs
//    every few minutes) create a notice once per user and event. Unique with
//    user_id, so a second insert is skipped instead of duplicating the notice.
//  - business_units.notification_priorities: per-unit priority overrides,
//    { "<event key>": "high" | "medium" | "low" }.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.addColumn("notifications", "event", {
            type: Sequelize.STRING(40),
            allowNull: false,
            defaultValue: "general",
        });
        await queryInterface.addColumn("notifications", "priority", {
            type: Sequelize.STRING(10),
            allowNull: false,
            defaultValue: "medium",
        });
        await queryInterface.addColumn("notifications", "dedupe_key", {
            type: Sequelize.STRING(120),
            allowNull: true,
        });
        await queryInterface.addIndex("notifications", ["user_id", "dedupe_key"], {
            name: "notifications_user_id_dedupe_key",
            unique: true,
            where: { dedupe_key: { [Sequelize.Op.ne]: null } },
        });
        await queryInterface.addIndex("notifications", ["user_id", "created_at"], {
            name: "notifications_user_id_created_at",
        });

        await queryInterface.addColumn("business_units", "notification_priorities", {
            type: Sequelize.JSONB,
            allowNull: false,
            defaultValue: {},
        });
    },

    async down(queryInterface) {
        await queryInterface.removeColumn("business_units", "notification_priorities");
        await queryInterface.removeIndex("notifications", "notifications_user_id_created_at");
        await queryInterface.removeIndex("notifications", "notifications_user_id_dedupe_key");
        await queryInterface.removeColumn("notifications", "dedupe_key");
        await queryInterface.removeColumn("notifications", "priority");
        await queryInterface.removeColumn("notifications", "event");
    },
};
