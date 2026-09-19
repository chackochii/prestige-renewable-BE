"use strict";

// Cross-department collaboration (Sep 2026): the requests and assignments
// people raise from a stage when the next step belongs to another team.
//
//  - collaboration_requests: one row per request. Two kinds behave differently
//    — "information" is answered once on a form built from the fields the
//    requester asked for (the response lives on this row); "assignment" is
//    worked over time and tracked in collaboration_progress.
//  - collaboration_progress: the assignee moving an assignment along. Entries
//    marked internal stay inside the assignee's department.
//  - collaboration_attachments: files supplied against a request — "attachment"
//    answers a requested document, "report" is what the requester waits on.
//  - collaboration_events: the audit trail shown on the request's history tab.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        const timestamps = {
            created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
            updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
        };
        const userFk = {
            type: Sequelize.INTEGER,
            allowNull: true,
            references: { model: "users", key: "id" },
            onUpdate: "CASCADE",
            onDelete: "SET NULL",
        };
        const requestFk = {
            type: Sequelize.INTEGER,
            allowNull: false,
            references: { model: "collaboration_requests", key: "id" },
            onUpdate: "CASCADE",
            onDelete: "CASCADE",
        };

        await queryInterface.createTable("collaboration_requests", {
            id: { type: Sequelize.INTEGER, primaryKey: true, allowNull: false, autoIncrement: true },
            business_unit_id: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: { model: "business_units", key: "id" },
                onUpdate: "CASCADE",
                onDelete: "RESTRICT",
            },
            opportunity_id: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: { model: "opportunities", key: "id" },
                onUpdate: "CASCADE",
                onDelete: "CASCADE",
            },
            kind: { type: Sequelize.STRING(20), allowNull: false }, // information | assignment
            department: { type: Sequelize.STRING(20), allowNull: false },
            stage: { type: Sequelize.INTEGER, allowNull: true }, // the stage it was raised from
            title: { type: Sequelize.STRING(200), allowNull: false },
            description: { type: Sequelize.TEXT },
            // What the requester asked for: [{ key, label, type }] and
            // [{ key, label, type, comment }].
            requested_fields: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
            requested_documents: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
            created_by_id: { ...userFk },
            assignee_id: { ...userFk },
            priority: { type: Sequelize.STRING(10), allowNull: false, defaultValue: "medium" },
            due_at: { type: Sequelize.DATE },
            scheduled_for: { type: Sequelize.DATE }, // assignments: when the visit is booked
            status: { type: Sequelize.STRING(30), allowNull: false },
            clarification_note: { type: Sequelize.TEXT }, // why it went back to the assignee
            cancelled_reason: { type: Sequelize.TEXT },
            // The information response, one per request (a draft is private to
            // the assignee until submitted).
            response_fields: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
            response_note: { type: Sequelize.TEXT },
            response_draft: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
            response_submitted_at: { type: Sequelize.DATE },
            response_submitted_by_id: { ...userFk },
            ...timestamps,
            deleted_at: { type: Sequelize.DATE },
        });
        await queryInterface.addIndex("collaboration_requests", ["opportunity_id"]);
        await queryInterface.addIndex("collaboration_requests", ["business_unit_id", "status"]);
        await queryInterface.addIndex("collaboration_requests", ["assignee_id", "status"]);
        await queryInterface.addIndex("collaboration_requests", ["created_by_id", "status"]);

        await queryInterface.createTable("collaboration_progress", {
            id: { type: Sequelize.INTEGER, primaryKey: true, allowNull: false, autoIncrement: true },
            request_id: { ...requestFk },
            status: { type: Sequelize.STRING(30), allowNull: false },
            note: { type: Sequelize.TEXT },
            // Kept inside the assignee's department — never returned to the requester.
            internal: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
            author_id: { ...userFk },
            ...timestamps,
        });
        await queryInterface.addIndex("collaboration_progress", ["request_id", "created_at"]);

        await queryInterface.createTable("collaboration_attachments", {
            id: { type: Sequelize.INTEGER, primaryKey: true, allowNull: false, autoIncrement: true },
            request_id: { ...requestFk },
            category: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "attachment" }, // attachment | report
            document_key: { type: Sequelize.STRING(60) }, // the requested document it answers
            filename: { type: Sequelize.STRING, allowNull: false },
            mime: { type: Sequelize.STRING(100) },
            size: { type: Sequelize.INTEGER },
            storage_key: { type: Sequelize.STRING(1000), allowNull: false }, // object key in the Space
            uploader_id: { ...userFk },
            ...timestamps,
        });
        await queryInterface.addIndex("collaboration_attachments", ["request_id"]);

        await queryInterface.createTable("collaboration_events", {
            id: { type: Sequelize.INTEGER, primaryKey: true, allowNull: false, autoIncrement: true },
            request_id: { ...requestFk },
            action: { type: Sequelize.STRING(60), allowNull: false },
            detail: { type: Sequelize.TEXT },
            actor_id: { ...userFk },
            ...timestamps,
        });
        await queryInterface.addIndex("collaboration_events", ["request_id", "created_at"]);
    },

    async down(queryInterface) {
        await queryInterface.dropTable("collaboration_events");
        await queryInterface.dropTable("collaboration_attachments");
        await queryInterface.dropTable("collaboration_progress");
        await queryInterface.dropTable("collaboration_requests");
    },
};
