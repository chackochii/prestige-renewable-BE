"use strict";

// Automated lead capture goes live (Nov 2026): Meta and Google Ads webhooks
// now write into the review queue designed in 20260827000001. What the
// webhook layer needs on top of that design:
//
//   integration_connections.last_sync_at   when the Meta poll last ran (its cursor)
//   integration_connections.last_error     the last platform error, shown on the
//   integration_connections.last_error_at  connections screen (an expired token, say)
//   inbound_leads.fetch_error              a Meta lead whose answers could not be
//                                          fetched yet — kept as a stub, refreshed later
//
// The webhook secret becomes unique: a Google Ads lead carries only the key,
// so the key alone has to find the connection.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.addColumn("integration_connections", "last_sync_at", { type: Sequelize.DATE, allowNull: true });
        await queryInterface.addColumn("integration_connections", "last_error", { type: Sequelize.TEXT, allowNull: true });
        await queryInterface.addColumn("integration_connections", "last_error_at", { type: Sequelize.DATE, allowNull: true });
        await queryInterface.sequelize.query(
            `CREATE UNIQUE INDEX integration_connections_webhook_secret_uq
             ON integration_connections (webhook_secret)
             WHERE webhook_secret IS NOT NULL`
        );

        await queryInterface.addColumn("inbound_leads", "fetch_error", { type: Sequelize.TEXT, allowNull: true });
        // The inbox: one unit, one status, newest first.
        await queryInterface.addIndex("inbound_leads", ["business_unit_id", "status", "received_at"], {
            name: "inbound_leads_unit_status_received_idx",
        });
    },

    async down(queryInterface) {
        await queryInterface.removeIndex("inbound_leads", "inbound_leads_unit_status_received_idx");
        await queryInterface.removeColumn("inbound_leads", "fetch_error");
        await queryInterface.sequelize.query("DROP INDEX IF EXISTS integration_connections_webhook_secret_uq");
        await queryInterface.removeColumn("integration_connections", "last_error_at");
        await queryInterface.removeColumn("integration_connections", "last_error");
        await queryInterface.removeColumn("integration_connections", "last_sync_at");
    },
};
