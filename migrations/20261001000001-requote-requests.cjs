"use strict";

// Re-quotes: the customer asked for changes to their proposal, so sales sends
// the job back to estimation to be re-priced.
//
// One requote_requests row per round. It carries what the customer said (in
// their own words, as they answered the proposal — or as sales recorded it),
// sales' comments for the estimator, who it was assigned to, and — once the
// estimator hands the revised quote back — what changed and which saved
// version it became. The job itself moves back to stage 2 while the row is
// open and returns to stage 3 when it is completed.
//
// opportunities.requote_requested_at mirrors "an open re-quote exists" so the
// pipeline board and lists can flag the job without a join; it is cleared when
// the round is completed.

module.exports = {
    async up(queryInterface, Sequelize) {
        const userRef = () => ({
            type: Sequelize.INTEGER,
            allowNull: true,
            references: { model: "users", key: "id" },
            onUpdate: "CASCADE",
            onDelete: "SET NULL",
        });
        const versionRef = () => ({
            type: Sequelize.INTEGER,
            allowNull: true,
            references: { model: "quote_versions", key: "id" },
            onUpdate: "CASCADE",
            onDelete: "SET NULL",
        });

        await queryInterface.createTable("requote_requests", {
            id: { type: Sequelize.INTEGER, primaryKey: true, allowNull: false, autoIncrement: true },
            opportunity_id: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: { model: "opportunities", key: "id" },
                onUpdate: "CASCADE",
                onDelete: "CASCADE",
            },
            // Which round on this job: 1, 2, 3 …
            round: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
            // open — with the estimator; completed — revised quote handed back.
            status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "open" },

            // The proposal the customer answered and the quote version they saw.
            proposal_id: {
                type: Sequelize.INTEGER,
                allowNull: true,
                references: { model: "proposals", key: "id" },
                onUpdate: "CASCADE",
                onDelete: "SET NULL",
            },
            quote_version_id: versionRef(),

            // What the customer asked for: their words as they answered the
            // proposal (customer_channel = customer), as sales recorded them
            // after a call (staff), or typed by sales when raising this (null).
            customer_message: { type: Sequelize.TEXT, allowNull: true },
            customer_name: { type: Sequelize.STRING(120), allowNull: true },
            customer_channel: { type: Sequelize.STRING(20), allowNull: true },
            customer_responded_at: { type: Sequelize.DATE, allowNull: true },

            // Sales' instructions to the estimator.
            comments: { type: Sequelize.TEXT, allowNull: false },
            requested_by_id: userRef(),
            estimator_id: userRef(),

            // The estimator's hand-back.
            completed_at: { type: Sequelize.DATE, allowNull: true },
            completed_by_id: userRef(),
            estimator_note: { type: Sequelize.TEXT, allowNull: true },
            revised_quote_version_id: versionRef(),

            created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
            updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
        });
        await queryInterface.addIndex("requote_requests", ["opportunity_id", "created_at"], { name: "requote_requests_opportunity_created" });
        await queryInterface.addIndex("requote_requests", ["opportunity_id", "status"], { name: "requote_requests_opportunity_status" });

        await queryInterface.addColumn("opportunities", "requote_requested_at", { type: Sequelize.DATE, allowNull: true });
    },

    async down(queryInterface) {
        await queryInterface.removeColumn("opportunities", "requote_requested_at");
        await queryInterface.dropTable("requote_requests");
    },
};
