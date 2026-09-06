"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        // One row per connected lead source: an ad account (Google/Meta/
        // LinkedIn) or a ServiceM8 account, owned by ONE business unit —
        // incoming leads inherit the connection's unit. Connecting a new
        // account is an insert, not a code change.
        await queryInterface.createTable("integration_connections", {
            id: {
                type: Sequelize.INTEGER,
                primaryKey: true,
                allowNull: false,
                autoIncrement: true,
            },
            business_unit_id: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: { model: "business_units", key: "id" },
                onUpdate: "CASCADE",
                onDelete: "CASCADE",
            },
            platform: { type: Sequelize.STRING(20), allowNull: false }, // google_ads | meta_ads | linkedin_ads | servicem8
            name: { type: Sequelize.STRING, allowNull: false }, // display, e.g. "PRS Google Ads"
            external_account_id: { type: Sequelize.STRING }, // ad account id / ServiceM8 account uuid
            webhook_secret: { type: Sequelize.STRING }, // verifies incoming webhook calls
            credentials: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} }, // tokens, page/form ids
            config: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} }, // platform-specific mapping/settings
            auto_convert: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false }, // future: skip the review queue
            is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
            last_event_at: { type: Sequelize.DATE }, // last webhook received — connection health
            created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
            updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
        });

        await queryInterface.addIndex("integration_connections", ["business_unit_id"]);
        await queryInterface.addIndex("integration_connections", ["platform", "external_account_id"]);

        // Review queue: every automated lead lands here exactly as received
        // (payload) plus normalized contact + attribution columns. A reviewer
        // converts it into an opportunity or rejects it; duplicates are kept
        // and flagged via duplicate_of_id.
        await queryInterface.createTable("inbound_leads", {
            id: {
                type: Sequelize.INTEGER,
                primaryKey: true,
                allowNull: false,
                autoIncrement: true,
            },
            connection_id: {
                type: Sequelize.INTEGER,
                allowNull: true, // kept when a connection is later removed
                references: { model: "integration_connections", key: "id" },
                onUpdate: "CASCADE",
                onDelete: "SET NULL",
            },
            business_unit_id: {
                // snapshot from the connection at ingest time
                type: Sequelize.INTEGER,
                allowNull: false,
                references: { model: "business_units", key: "id" },
                onUpdate: "CASCADE",
                onDelete: "CASCADE",
            },
            source: { type: Sequelize.STRING(20), allowNull: false }, // google_ads | meta_ads | linkedin_ads | servicem8
            external_lead_id: { type: Sequelize.STRING }, // platform's lead id — idempotency key
            status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "pending" }, // pending | converted | rejected
            payload: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} }, // raw webhook body, never lost

            // Normalized contact (best-effort mapping from the platform form)
            name: { type: Sequelize.STRING },
            email: { type: Sequelize.STRING },
            phone: { type: Sequelize.STRING },
            company: { type: Sequelize.STRING },
            suburb: { type: Sequelize.STRING },
            postcode: { type: Sequelize.STRING(10) },
            message: { type: Sequelize.TEXT }, // free-text / enquiry field

            // Attribution (Google campaign/ad group, Meta campaign/adset,
            // LinkedIn campaign/creative — generic names, raw ids in payload)
            campaign_id: { type: Sequelize.STRING },
            campaign_name: { type: Sequelize.STRING },
            ad_group_id: { type: Sequelize.STRING },
            ad_group_name: { type: Sequelize.STRING },
            ad_id: { type: Sequelize.STRING },
            ad_name: { type: Sequelize.STRING },
            form_id: { type: Sequelize.STRING },
            form_name: { type: Sequelize.STRING },

            // Duplicate flag: points at the earlier lead this one matches
            // (same email/phone); the row is kept and still convertible.
            duplicate_of_id: {
                type: Sequelize.INTEGER,
                allowNull: true,
                references: { model: "inbound_leads", key: "id" },
                onUpdate: "CASCADE",
                onDelete: "SET NULL",
            },

            // Review outcome
            opportunity_id: {
                type: Sequelize.INTEGER,
                allowNull: true,
                references: { model: "opportunities", key: "id" },
                onUpdate: "CASCADE",
                onDelete: "SET NULL",
            },
            reviewed_by_id: {
                type: Sequelize.INTEGER,
                allowNull: true,
                references: { model: "users", key: "id" },
                onUpdate: "CASCADE",
                onDelete: "SET NULL",
            },
            reviewed_at: { type: Sequelize.DATE },
            reject_reason: { type: Sequelize.TEXT },

            received_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
            created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
            updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
        });

        // A platform re-sending the same lead is a no-op, not a second row.
        await queryInterface.sequelize.query(
            `CREATE UNIQUE INDEX inbound_leads_source_external_id_uq
             ON inbound_leads (source, external_lead_id)
             WHERE external_lead_id IS NOT NULL`
        );
        await queryInterface.addIndex("inbound_leads", ["status"]);
        await queryInterface.addIndex("inbound_leads", ["business_unit_id"]);
        await queryInterface.addIndex("inbound_leads", ["email"]);
        await queryInterface.addIndex("inbound_leads", ["phone"]);
        await queryInterface.addIndex("inbound_leads", ["opportunity_id"]);

        // Back-link on opportunities so the pipeline can report campaign
        // attribution with one join. leadSource values widen in the model.
        await queryInterface.addColumn("opportunities", "inbound_lead_id", {
            type: Sequelize.INTEGER,
            allowNull: true,
            references: { model: "inbound_leads", key: "id" },
            onUpdate: "CASCADE",
            onDelete: "SET NULL",
        });
        await queryInterface.addIndex("opportunities", ["inbound_lead_id"]);
    },

    async down(queryInterface) {
        await queryInterface.removeColumn("opportunities", "inbound_lead_id");
        await queryInterface.dropTable("inbound_leads");
        await queryInterface.dropTable("integration_connections");
    },
};
