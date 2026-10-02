"use strict";

// Approvals (stage 5) connected to the pipeline.
//
// Which approvals a job needs is decided early — by sales on the lead form
// or by estimation — and kept on the record as `required_approvals`, an
// array of keys from the unit's approvalTypes catalogue. Estimation used to
// tick the same thing into estimation_input.permits, which nothing read;
// those answers are carried over.
//
// The `approvals` table (one row per type per job, unused until now) gains
// what the approvals screen records: the authority it is with, the reference,
// who lodged it, and the Operations Coordinator's checklist answers (CL-07
// DNSP, CL-08 DA, CL-09 finance) as JSON. Statuses move to the keys the
// screen uses. Rows are created when the job enters the stage, for the
// required types only.
//
// Units still on the original approvalTypes default get the fuller
// catalogue; edited lists are left alone.

const OLD_DEFAULT = [
    { key: "council", label: "Council / DA" },
    { key: "dnsp", label: "DNSP grid connection" },
    { key: "strata", label: "Facility / strata" },
    { key: "rebate", label: "Rebate pre-approval" },
];
const NEW_DEFAULT = [
    { key: "dnsp", label: "DNSP / network connection approval" },
    { key: "da", label: "Council DA / development consent" },
    { key: "finance", label: "Finance approval" },
    { key: "strata", label: "Strata / body corporate approval" },
    { key: "heritage", label: "Heritage overlay approval" },
    { key: "landlord", label: "Landlord consent" },
    { key: "electrical_safety", label: "Electrical safety / CES notification" },
    { key: "rebate", label: "Rebate pre-approval" },
];

module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.addColumn("opportunities", "required_approvals", { type: Sequelize.JSONB, allowNull: false, defaultValue: [] });
        await queryInterface.sequelize.query(`
            UPDATE opportunities
               SET required_approvals = estimation_input->'permits'
             WHERE jsonb_typeof(estimation_input->'permits') = 'array'
               AND jsonb_array_length(estimation_input->'permits') > 0
        `);

        await queryInterface.addColumn("approvals", "authority", { type: Sequelize.STRING, allowNull: true });
        await queryInterface.addColumn("approvals", "reference", { type: Sequelize.STRING(120), allowNull: true });
        await queryInterface.addColumn("approvals", "owner_id", {
            type: Sequelize.INTEGER,
            allowNull: true,
            references: { model: "users", key: "id" },
            onUpdate: "CASCADE",
            onDelete: "SET NULL",
        });
        await queryInterface.addColumn("approvals", "checklist", { type: Sequelize.JSONB, allowNull: false, defaultValue: {} });
        await queryInterface.sequelize.query(`
            UPDATE approvals SET status = CASE status
                WHEN 'Not Started'  THEN 'not_started'
                WHEN 'Submitted'    THEN 'submitted'
                WHEN 'Pending'      THEN 'submitted'
                WHEN 'Approved'     THEN 'approved'
                WHEN 'Rejected'     THEN 'rejected'
                WHEN 'Expired'      THEN 'rejected'
                WHEN 'Not Required' THEN 'not_applicable'
                ELSE status END
        `);
        await queryInterface.changeColumn("approvals", "status", { type: Sequelize.STRING(20), allowNull: false, defaultValue: "not_started" });
        await queryInterface.changeColumn("approvals", "owner_role", { type: Sequelize.STRING(5), allowNull: false, defaultValue: "OPC" });

        await queryInterface.sequelize.query("UPDATE business_units SET approval_types = :next::jsonb WHERE approval_types = :previous::jsonb", {
            replacements: { next: JSON.stringify(NEW_DEFAULT), previous: JSON.stringify(OLD_DEFAULT) },
        });
    },

    async down(queryInterface, Sequelize) {
        await queryInterface.sequelize.query("UPDATE business_units SET approval_types = :previous::jsonb WHERE approval_types = :next::jsonb", {
            replacements: { next: JSON.stringify(NEW_DEFAULT), previous: JSON.stringify(OLD_DEFAULT) },
        });
        await queryInterface.changeColumn("approvals", "owner_role", { type: Sequelize.STRING(5), allowNull: false, defaultValue: "BOP" });
        await queryInterface.sequelize.query(`
            UPDATE approvals SET status = CASE status
                WHEN 'not_started'    THEN 'Not Started'
                WHEN 'submitted'      THEN 'Submitted'
                WHEN 'approved'       THEN 'Approved'
                WHEN 'rejected'       THEN 'Rejected'
                WHEN 'not_applicable' THEN 'Not Required'
                ELSE status END
        `);
        await queryInterface.changeColumn("approvals", "status", { type: Sequelize.STRING(20), allowNull: false, defaultValue: "Not Started" });
        for (const column of ["checklist", "owner_id", "reference", "authority"]) await queryInterface.removeColumn("approvals", column);
        await queryInterface.removeColumn("opportunities", "required_approvals");
    },
};
