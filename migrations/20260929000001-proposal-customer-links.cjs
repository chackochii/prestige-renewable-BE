"use strict";

// Proposals sent to the customer by email, and the customer's answer.
//
// One proposals row per send. It records which saved quote version went out
// (the PDF is rebuilt from that version's snapshot, so the customer sees
// exactly what was sent), who it went to, and whether the email left. The
// customer's link is authorised by a random token; only its SHA-256 is kept,
// so a copy of the database cannot be used to accept a proposal. The answer —
// accept, reject or ask to renegotiate — is stored with the name typed and
// the address it came from, as the record of acceptance.
//
// Status gains "negotiation" (the customer asked for changes) and "withdrawn"
// (a newer proposal replaced this one before it was answered). "issued" is
// sent, "presented" is opened by the customer.

module.exports = {
    async up(queryInterface, Sequelize) {
        const add = (name, spec) => queryInterface.addColumn("proposals", name, spec);

        await add("quote_version_id", {
            type: Sequelize.INTEGER,
            allowNull: true,
            references: { model: "quote_versions", key: "id" },
            onUpdate: "CASCADE",
            onDelete: "SET NULL",
        });
        await add("grand_total", { type: Sequelize.DECIMAL(14, 2), allowNull: true });
        await add("token_hash", { type: Sequelize.STRING(64), allowNull: true });
        await add("expires_at", { type: Sequelize.DATE, allowNull: true });

        await add("sent_to", { type: Sequelize.STRING, allowNull: true });
        await add("sent_by_id", {
            type: Sequelize.INTEGER,
            allowNull: true,
            references: { model: "users", key: "id" },
            onUpdate: "CASCADE",
            onDelete: "SET NULL",
        });
        await add("email_subject", { type: Sequelize.STRING(200), allowNull: true });
        await add("email_message", { type: Sequelize.TEXT, allowNull: true });
        // sent | failed | not_configured — whether the email actually left.
        await add("email_status", { type: Sequelize.STRING(20), allowNull: true });
        await add("email_error", { type: Sequelize.STRING(500), allowNull: true });

        await add("viewed_at", { type: Sequelize.DATE, allowNull: true });
        await add("view_count", { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 });

        // accepted | rejected | renegotiate
        await add("response", { type: Sequelize.STRING(20), allowNull: true });
        await add("responded_at", { type: Sequelize.DATE, allowNull: true });
        await add("response_name", { type: Sequelize.STRING(120), allowNull: true });
        await add("response_note", { type: Sequelize.TEXT, allowNull: true });
        await add("response_ip", { type: Sequelize.STRING(64), allowNull: true });
        // customer (through the link) | staff (recorded after a call)
        await add("response_channel", { type: Sequelize.STRING(20), allowNull: true });
        await add("recorded_by_id", {
            type: Sequelize.INTEGER,
            allowNull: true,
            references: { model: "users", key: "id" },
            onUpdate: "CASCADE",
            onDelete: "SET NULL",
        });

        await queryInterface.addIndex("proposals", ["token_hash"], { unique: true, name: "proposals_token_hash_unique" });
        await queryInterface.addIndex("proposals", ["opportunity_id", "created_at"], { name: "proposals_opportunity_created" });
    },

    async down(queryInterface) {
        await queryInterface.removeIndex("proposals", "proposals_opportunity_created");
        await queryInterface.removeIndex("proposals", "proposals_token_hash_unique");
        for (const column of [
            "recorded_by_id",
            "response_channel",
            "response_ip",
            "response_note",
            "response_name",
            "responded_at",
            "response",
            "view_count",
            "viewed_at",
            "email_error",
            "email_status",
            "email_message",
            "email_subject",
            "sent_by_id",
            "sent_to",
            "expires_at",
            "token_hash",
            "grand_total",
            "quote_version_id",
        ])
            await queryInterface.removeColumn("proposals", column);
    },
};
