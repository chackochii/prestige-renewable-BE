"use strict";

// Site-visit forms, and the two request changes that came with them.
//
// 1. Assignments get their own priority scale. An information request is low →
//    urgent; an assignment says whether the activity has to happen at all:
//    required | preferred | not_required. "not_required" does not fit the old
//    STRING(10), so the column widens, and existing assignments are moved onto
//    the new scale so they still validate the next time they are saved.
//
// 2. A pre-site inspection carries the checklist items the requester marked
//    as required (inspection_checklist), which become the site member's form.
//
// 3. collaboration_site_visits: the form a coordinator hands to whoever is
//    attending. The token is the public link's whole authority — one task,
//    nothing else — so it is unique and unguessable, and one request has at
//    most one form.

// Old assignment priority → new, and back again for `down`.
const TO_NEW = { urgent: "required", high: "required", medium: "preferred", low: "not_required" };
const TO_OLD = { required: "high", preferred: "medium", not_required: "low" };

module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.changeColumn("collaboration_requests", "priority", {
            type: Sequelize.STRING(20),
            allowNull: false,
            defaultValue: "medium",
        });
        for (const [from, to] of Object.entries(TO_NEW)) {
            await queryInterface.sequelize.query(
                "UPDATE collaboration_requests SET priority = :to WHERE kind = 'assignment' AND priority = :from",
                { replacements: { from, to } }
            );
        }

        await queryInterface.addColumn("collaboration_requests", "inspection_checklist", {
            type: Sequelize.JSONB,
            allowNull: false,
            defaultValue: [],
        });

        await queryInterface.createTable("collaboration_site_visits", {
            id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
            request_id: {
                type: Sequelize.INTEGER,
                allowNull: false,
                unique: true,
                references: { model: "collaboration_requests", key: "id" },
                onDelete: "CASCADE",
            },
            token: { type: Sequelize.STRING(64), allowNull: false, unique: true },
            status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "pending" },
            // Someone in the directory, or a name typed in for a contractor who
            // has no account here — exactly one of the two is set.
            assignee_id: {
                type: Sequelize.INTEGER,
                allowNull: true,
                references: { model: "users", key: "id" },
                onDelete: "SET NULL",
            },
            assignee_name: { type: Sequelize.STRING(120), allowNull: true },
            assignee_email: { type: Sequelize.STRING(254), allowNull: true },
            assignee_phone: { type: Sequelize.STRING(40), allowNull: true },
            requested_fields: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
            requested_documents: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
            // What came back: { name, email, phone, fields: { key: answer } }.
            response: { type: Sequelize.JSONB, allowNull: true },
            submitted_at: { type: Sequelize.DATE, allowNull: true },
            created_by_id: {
                type: Sequelize.INTEGER,
                allowNull: true,
                references: { model: "users", key: "id" },
                onDelete: "SET NULL",
            },
            created_at: { type: Sequelize.DATE, allowNull: false },
            updated_at: { type: Sequelize.DATE, allowNull: false },
        });
    },

    async down(queryInterface, Sequelize) {
        await queryInterface.dropTable("collaboration_site_visits");
        await queryInterface.removeColumn("collaboration_requests", "inspection_checklist");
        for (const [from, to] of Object.entries(TO_OLD)) {
            await queryInterface.sequelize.query(
                "UPDATE collaboration_requests SET priority = :to WHERE kind = 'assignment' AND priority = :from",
                { replacements: { from, to } }
            );
        }
        await queryInterface.changeColumn("collaboration_requests", "priority", {
            type: Sequelize.STRING(10),
            allowNull: false,
            defaultValue: "medium",
        });
    },
};
