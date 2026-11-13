"use strict";

// Excel export of job data (Nov 2026). One permission, admin.export, guards
// both downloads: a single job from its page (GET /opportunities/:id/export)
// and every job in a business unit (GET /opportunities/export). An export
// carries customers' names, phone numbers and addresses out of the system, so
// nobody holds it by default except the superadmin (ADM, who bypasses checks
// anyway — the grant row is there so the roles screen shows it ticked). Other
// roles get it on the roles screen.
//
// The permission is also in seeders/roles-permissions.cjs, so a database built
// from scratch has it; this migration adds it to databases that already exist.

const CODE = "admin.export";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface) {
        const { sequelize } = queryInterface;
        await sequelize.query(
            `INSERT INTO permissions (code, name, category, is_system, created_at, updated_at)
             VALUES (:code, 'Export data to Excel', 'System Administration', true, NOW(), NOW())
             ON CONFLICT (code) DO UPDATE
             SET name = EXCLUDED.name, category = EXCLUDED.category, is_system = true, updated_at = NOW()`,
            { replacements: { code: CODE } }
        );
        // On a brand-new database the roles do not exist yet; the seeder grants it then.
        await sequelize.query(
            `INSERT INTO role_permissions (role_id, permission_id, created_at, updated_at)
             SELECT r.id, p.id, NOW(), NOW()
             FROM roles r, permissions p
             WHERE r.code = 'ADM' AND p.code = :code
             ON CONFLICT (role_id, permission_id) DO NOTHING`,
            { replacements: { code: CODE } }
        );
    },

    async down(queryInterface) {
        // Grants cascade with the permission row.
        await queryInterface.bulkDelete("permissions", { code: CODE });
    },
};
