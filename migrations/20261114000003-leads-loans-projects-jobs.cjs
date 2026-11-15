"use strict";

// Lead assignment history, quote approvals, loan requests, customer payments,
// projects, job schedules and completed installations (Nov 2026).
//
//   lead_assignments        every salesperson assignment, reassignment and
//                           unassignment on a lead: from whom, to whom, by
//                           whom, why. A lead already assigned cannot be given
//                           to another rep except by an authorised user
//                           (leads.approve) — leadAssignmentService.
//   quote_approvals         a Senior Sales Representative's sign-off on a quote
//                           version before it goes to the customer: pending →
//                           approved | rejected, and resubmitted after a
//                           rejection; comments and the approver kept.
//   loan_requests           finance applications raised by sales on a lead,
//                           reviewed by finance; replies in loan_request_messages.
//   customer_payments       what customers owe, GST included, and what has
//                           been received against it (receipts).
//   projects                a signed job: payment type (cash | loan), approval,
//                           installation and procurement progress, the rep.
//   job_schedules           jobs on the calendar, routed to a team by the kind
//                           of work (installation → crew, delivery → procurement …).
//   installations           completed installations with the signed quote,
//                           the payment method and the invoice status.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        const timestamps = {
            created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
            updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
        };
        const userRef = { type: Sequelize.INTEGER, allowNull: true, references: { model: "users", key: "id" }, onDelete: "SET NULL" };
        const unitRef = (allowNull = false) => ({
            type: Sequelize.INTEGER,
            allowNull,
            references: { model: "business_units", key: "id" },
            onDelete: "CASCADE",
        });
        const opportunityRef = (allowNull = false, onDelete = "CASCADE") => ({
            type: Sequelize.INTEGER,
            allowNull,
            references: { model: "opportunities", key: "id" },
            onDelete,
        });

        await queryInterface.createTable("lead_assignments", {
            id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            opportunity_id: opportunityRef(),
            from_user_id: userRef,
            to_user_id: userRef,
            assigned_by_id: userRef,
            kind: { type: Sequelize.STRING(20), allowNull: false }, // assigned | reassigned | unassigned
            reason: { type: Sequelize.STRING(2000), allowNull: true },
            created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
        });
        await queryInterface.addIndex("lead_assignments", ["opportunity_id", "created_at"], { name: "lead_assignments_opportunity" });

        await queryInterface.createTable("quote_approvals", {
            id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            opportunity_id: opportunityRef(),
            business_unit_id: unitRef(),
            quote_id: { type: Sequelize.INTEGER, allowNull: true, references: { model: "quotes", key: "id" }, onDelete: "SET NULL" },
            quote_version_id: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: { model: "quote_versions", key: "id" },
                onDelete: "CASCADE",
            },
            round: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
            status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "pending" }, // pending | approved | rejected | resubmitted
            submitted_by_id: userRef,
            submitted_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
            submission_note: { type: Sequelize.STRING(2000), allowNull: true },
            approver_id: userRef,
            decided_at: { type: Sequelize.DATE, allowNull: true },
            comments: { type: Sequelize.STRING(4000), allowNull: true },
            ...timestamps,
        });
        await queryInterface.addIndex("quote_approvals", ["opportunity_id", "created_at"], { name: "quote_approvals_opportunity" });
        await queryInterface.addIndex("quote_approvals", ["business_unit_id", "status"], { name: "quote_approvals_unit_status" });
        await queryInterface.addIndex("quote_approvals", ["quote_version_id"], { name: "quote_approvals_version" });

        await queryInterface.createTable("loan_requests", {
            id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            opportunity_id: opportunityRef(),
            business_unit_id: unitRef(),
            number: { type: Sequelize.STRING(30), allowNull: true }, // LN-26-0001
            customer_name: { type: Sequelize.STRING(255), allowNull: true },
            customer_email: { type: Sequelize.STRING(254), allowNull: true },
            customer_phone: { type: Sequelize.STRING(30), allowNull: true },
            customer_address: { type: Sequelize.STRING(500), allowNull: true },
            loan_amount: { type: Sequelize.DECIMAL(14, 2), allowNull: false },
            deposit_amount: { type: Sequelize.DECIMAL(14, 2), allowNull: true },
            term_months: { type: Sequelize.INTEGER, allowNull: true },
            financier: { type: Sequelize.STRING(120), allowNull: true },
            sales_rep_id: userRef,
            submitted_by_id: userRef,
            application_date: { type: Sequelize.DATEONLY, allowNull: false },
            status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "submitted" }, // submitted | under_review | more_info | approved | declined | withdrawn
            reviewed_by_id: userRef,
            decided_at: { type: Sequelize.DATE, allowNull: true },
            financier_reference: { type: Sequelize.STRING(120), allowNull: true },
            financier_response: { type: Sequelize.TEXT, allowNull: true },
            financier_response_at: { type: Sequelize.DATE, allowNull: true },
            notes: { type: Sequelize.TEXT, allowNull: true },
            deleted_at: { type: Sequelize.DATE, allowNull: true },
            ...timestamps,
        });
        await queryInterface.addIndex("loan_requests", ["business_unit_id", "status"], { name: "loan_requests_unit_status" });
        await queryInterface.addIndex("loan_requests", ["opportunity_id"], { name: "loan_requests_opportunity" });

        await queryInterface.createTable("loan_request_messages", {
            id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            loan_request_id: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: { model: "loan_requests", key: "id" },
                onDelete: "CASCADE",
            },
            author_id: userRef,
            kind: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "reply" }, // reply | status | financier
            body: { type: Sequelize.TEXT, allowNull: false },
            created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
        });
        await queryInterface.addIndex("loan_request_messages", ["loan_request_id", "created_at"], { name: "loan_request_messages_request" });

        await queryInterface.createTable("projects", {
            id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            opportunity_id: { ...opportunityRef(), unique: true },
            business_unit_id: unitRef(),
            code: { type: Sequelize.STRING(30), allowNull: false }, // PRS-PRJ-26-0001
            payment_type: { type: Sequelize.STRING(10), allowNull: false, defaultValue: "cash" }, // cash | loan
            loan_request_id: {
                type: Sequelize.INTEGER,
                allowNull: true,
                references: { model: "loan_requests", key: "id" },
                onDelete: "SET NULL",
            },
            status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "signed" },
            installation_status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "not_started" },
            installation_progress_pct: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
            procurement_status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "not_started" },
            assigned_rep_id: userRef,
            operations_owner_id: userRef,
            signed_at: { type: Sequelize.DATE, allowNull: true },
            expected_install_date: { type: Sequelize.DATEONLY, allowNull: true },
            notes: { type: Sequelize.TEXT, allowNull: true },
            created_by_id: userRef,
            ...timestamps,
        });
        await queryInterface.addIndex("projects", ["business_unit_id", "status"], { name: "projects_unit_status" });
        await queryInterface.addIndex("projects", ["code"], { unique: true, name: "projects_code_uq" });

        await queryInterface.createTable("job_schedules", {
            id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            business_unit_id: unitRef(),
            opportunity_id: opportunityRef(true, "SET NULL"),
            project_id: { type: Sequelize.INTEGER, allowNull: true, references: { model: "projects", key: "id" }, onDelete: "SET NULL" },
            title: { type: Sequelize.STRING(200), allowNull: false },
            job_type: { type: Sequelize.STRING(30), allowNull: false },
            team: { type: Sequelize.STRING(20), allowNull: false }, // crew | operations | procurement | om | sales
            assignee_id: userRef,
            scheduled_start: { type: Sequelize.DATE, allowNull: false },
            scheduled_end: { type: Sequelize.DATE, allowNull: true },
            status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "scheduled" }, // scheduled | in_progress | completed | cancelled
            location: { type: Sequelize.STRING(500), allowNull: true },
            notes: { type: Sequelize.TEXT, allowNull: true },
            completed_at: { type: Sequelize.DATE, allowNull: true },
            created_by_id: userRef,
            ...timestamps,
        });
        await queryInterface.addIndex("job_schedules", ["business_unit_id", "scheduled_start"], { name: "job_schedules_unit_start" });
        await queryInterface.addIndex("job_schedules", ["assignee_id", "status"], { name: "job_schedules_assignee_status" });

        await queryInterface.createTable("installations", {
            id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            opportunity_id: opportunityRef(),
            business_unit_id: unitRef(),
            project_id: { type: Sequelize.INTEGER, allowNull: true, references: { model: "projects", key: "id" }, onDelete: "SET NULL" },
            job_schedule_id: { type: Sequelize.INTEGER, allowNull: true, references: { model: "job_schedules", key: "id" }, onDelete: "SET NULL" },
            installation_date: { type: Sequelize.DATEONLY, allowNull: false },
            job_description: { type: Sequelize.STRING(2000), allowNull: true },
            installer_id: userRef,
            signed_quote_version_id: {
                type: Sequelize.INTEGER,
                allowNull: true,
                references: { model: "quote_versions", key: "id" },
                onDelete: "SET NULL",
            },
            system_summary: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
            payment_method: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "cash" }, // cash | loan | card | bank_transfer | other
            invoice_status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "not_invoiced" }, // not_invoiced | invoiced | partially_paid | paid
            invoice_number: { type: Sequelize.STRING(60), allowNull: true },
            notes: { type: Sequelize.TEXT, allowNull: true },
            completed_by_id: userRef,
            ...timestamps,
        });
        await queryInterface.addIndex("installations", ["business_unit_id", "installation_date"], { name: "installations_unit_date" });
        await queryInterface.addIndex("installations", ["opportunity_id"], { name: "installations_opportunity" });

        await queryInterface.createTable("customer_payments", {
            id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            opportunity_id: opportunityRef(),
            business_unit_id: unitRef(),
            project_id: { type: Sequelize.INTEGER, allowNull: true, references: { model: "projects", key: "id" }, onDelete: "SET NULL" },
            description: { type: Sequelize.STRING(255), allowNull: false },
            milestone: { type: Sequelize.STRING(40), allowNull: true }, // deposit | delivery | final | …
            amount_ex: { type: Sequelize.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
            gst_rate_pct: { type: Sequelize.DECIMAL(5, 2), allowNull: false, defaultValue: 10 },
            gst_amount: { type: Sequelize.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
            amount_inc: { type: Sequelize.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
            due_at: { type: Sequelize.DATEONLY, allowNull: true },
            invoice_number: { type: Sequelize.STRING(60), allowNull: true },
            status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "unpaid" }, // unpaid | partial | paid | overdue | cancelled
            receipts: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] }, // [{ id, amount, receivedAt, method, reference, recordedById, recordedBy }]
            notes: { type: Sequelize.TEXT, allowNull: true },
            created_by_id: userRef,
            ...timestamps,
        });
        await queryInterface.addIndex("customer_payments", ["business_unit_id", "status"], { name: "customer_payments_unit_status" });
        await queryInterface.addIndex("customer_payments", ["opportunity_id"], { name: "customer_payments_opportunity" });
    },

    async down(queryInterface) {
        await queryInterface.dropTable("customer_payments");
        await queryInterface.dropTable("installations");
        await queryInterface.dropTable("job_schedules");
        await queryInterface.dropTable("projects");
        await queryInterface.dropTable("loan_request_messages");
        await queryInterface.dropTable("loan_requests");
        await queryInterface.dropTable("quote_approvals");
        await queryInterface.dropTable("lead_assignments");
    },
};
