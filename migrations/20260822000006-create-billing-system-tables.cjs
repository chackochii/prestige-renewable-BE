"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        const id = {
            type: Sequelize.INTEGER,
            primaryKey: true,
            allowNull: false,
            autoIncrement: true,
        };
        const opportunityFk = (allowNull) => ({
            type: Sequelize.INTEGER,
            allowNull,
            references: { model: "opportunities", key: "id" },
            onUpdate: "CASCADE",
            onDelete: "CASCADE",
        });
        const userFk = {
            type: Sequelize.INTEGER,
            allowNull: true,
            references: { model: "users", key: "id" },
            onUpdate: "CASCADE",
            onDelete: "SET NULL",
        };
        const timestamps = {
            created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
            updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
        };

        await queryInterface.createTable("billing_requests", {
            id: { ...id },
            opportunity_id: opportunityFk(false),
            milestone: { type: Sequelize.STRING(20), allowNull: false },
            percent: { type: Sequelize.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
            amount_ex: { type: Sequelize.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
            gst: { type: Sequelize.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
            status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "requested" },
            invoice_number: { type: Sequelize.STRING },
            payment_status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "unpaid" },
            event: { type: Sequelize.STRING },
            ...timestamps,
        });
        await queryInterface.addIndex("billing_requests", ["opportunity_id"]);

        await queryInterface.createTable("documents", {
            id: { ...id },
            opportunity_id: opportunityFk(false),
            type: { type: Sequelize.STRING(30), allowNull: false, defaultValue: "other" },
            name: { type: Sequelize.STRING, allowNull: false },
            version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
            uploader_id: { ...userFk },
            size: { type: Sequelize.STRING },
            mirror_status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "pending" },
            ...timestamps,
        });
        await queryInterface.addIndex("documents", ["opportunity_id"]);

        await queryInterface.createTable("audit_logs", {
            id: { ...id },
            opportunity_id: opportunityFk(false),
            actor_id: { ...userFk },
            action: { type: Sequelize.STRING, allowNull: false },
            detail: { type: Sequelize.TEXT },
            created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
        });
        await queryInterface.addIndex("audit_logs", ["opportunity_id"]);
        await queryInterface.addIndex("audit_logs", ["actor_id"]);

        await queryInterface.createTable("notifications", {
            id: { ...id },
            user_id: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: { model: "users", key: "id" },
                onUpdate: "CASCADE",
                onDelete: "CASCADE",
            },
            opportunity_id: opportunityFk(true),
            title: { type: Sequelize.STRING, allowNull: false },
            body: { type: Sequelize.TEXT },
            read: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
            ...timestamps,
        });
        await queryInterface.addIndex("notifications", ["user_id", "read"]);
    },

    async down(queryInterface) {
        await queryInterface.dropTable("notifications");
        await queryInterface.dropTable("audit_logs");
        await queryInterface.dropTable("documents");
        await queryInterface.dropTable("billing_requests");
    },
};
