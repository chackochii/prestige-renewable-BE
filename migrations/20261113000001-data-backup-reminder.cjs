"use strict";

// Excel backups and the 7-day reminder (Nov 2026).
//
// 1. data_exports: one row per Excel download — who, which business unit,
//    which job (one-job exports), the filters, how many jobs — and whether it
//    was a *full backup*: every job in the unit, no stage, lifecycle or date
//    filter. The newest full backup per unit is what the reminder measures
//    from (modules/export/service/backupReminder.js).
// 2. admin.export goes to the Business Owner (BO) and SysAdmin (SYS) as well as
//    the superadmin (ADM): the people who are reminded to take the backup can
//    take it. The permission now means "export every job in my business units"
//    (stage read rules do not narrow it), and its name on the roles screen
//    says so.

const CODE = "admin.export";
const NAME = "Export all job data to Excel (backups)";
const ROLES = ["BO", "SYS"];

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.createTable("data_exports", {
            id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            business_unit_id: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: { model: "business_units", key: "id" },
                onDelete: "CASCADE",
            },
            user_id: {
                type: Sequelize.INTEGER,
                allowNull: true,
                references: { model: "users", key: "id" },
                onDelete: "SET NULL",
            },
            // Set on a one-job export (the job page).
            opportunity_id: {
                type: Sequelize.INTEGER,
                allowNull: true,
                references: { model: "opportunities", key: "id" },
                onDelete: "SET NULL",
            },
            scope: { type: Sequelize.STRING(10), allowNull: false }, // job | unit
            full_backup: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
            job_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
            filters: { type: Sequelize.JSONB, allowNull: true },
            created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
        });
        await queryInterface.addIndex("data_exports", ["business_unit_id", "full_backup", "created_at"], {
            name: "data_exports_unit_full_created",
        });
        await queryInterface.addIndex("data_exports", ["user_id"], { name: "data_exports_user" });

        const { sequelize } = queryInterface;
        await sequelize.query("UPDATE permissions SET name = :name, updated_at = NOW() WHERE code = :code", {
            replacements: { code: CODE, name: NAME },
        });
        // On a brand-new database the roles do not exist yet; the seeder grants it then.
        await sequelize.query(
            `INSERT INTO role_permissions (role_id, permission_id, created_at, updated_at)
             SELECT r.id, p.id, NOW(), NOW()
             FROM roles r, permissions p
             WHERE r.code IN (:roles) AND p.code = :code
             ON CONFLICT (role_id, permission_id) DO NOTHING`,
            { replacements: { code: CODE, roles: ROLES } }
        );
    },

    async down(queryInterface) {
        const { sequelize } = queryInterface;
        await sequelize.query(
            `DELETE FROM role_permissions
             WHERE permission_id = (SELECT id FROM permissions WHERE code = :code)
               AND role_id IN (SELECT id FROM roles WHERE code IN (:roles))`,
            { replacements: { code: CODE, roles: ROLES } }
        );
        await sequelize.query("UPDATE permissions SET name = 'Export data to Excel', updated_at = NOW() WHERE code = :code", {
            replacements: { code: CODE },
        });
        await queryInterface.dropTable("data_exports");
    },
};
