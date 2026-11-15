"use strict";

// Permissions and the Senior Sales Representative role (Nov 2026).
//
// New permission codes, and who holds them by default (editable on the roles
// screen like every other grant):
//
//   pricing.cost.read        see purchase prices and margins — management and
//                            procurement; sales sees the sales price list only
//   equipment.update         add and edit equipment, categories, suppliers,
//                            supplier prices and margins
//   suppliers.credit.manage  credit limits, payment terms, deleting transactions
//   loans.create/read/update/delete   finance applications (loan requests)
//   quotes.approve           approve a quotation before it goes to the customer
//   activity.read            the activity log
//
// SSREP (Senior Sales Representative) holds what a sales representative holds
// plus leads.approve (may reassign leads) and quotes.approve. On a brand-new
// database the seeder creates the role; here the role is added for databases
// that already exist, and the grants are added for roles that exist.

const PERMISSIONS = [
    ["pricing.cost.read", "View purchase prices and margins", "Equipment & Pricing"],
    ["equipment.update", "Manage equipment, categories, suppliers and margins", "Equipment & Pricing"],
    ["suppliers.credit.manage", "Maintain supplier credit limits and payment terms", "Equipment & Pricing"],
    ["loans.create", "Create Finance & Loans", "Finance & Loans"],
    ["loans.read", "View Finance & Loans", "Finance & Loans"],
    ["loans.update", "Update Finance & Loans", "Finance & Loans"],
    ["loans.delete", "Delete Finance & Loans", "Finance & Loans"],
    ["quotes.approve", "Approve quotations before they go to the customer", "Estimation"],
    ["activity.read", "View the activity log", "System Administration"],
];

const SSREP = [
    "SSREP",
    "Senior Sales Representative",
    "Senior sales: everything a sales representative does, plus approving quotations before they go to the customer and reassigning leads between representatives",
];

// Role → the new codes it gets. SSREP also receives SREP's whole grant set below.
const GRANTS = {
    ADM: PERMISSIONS.map(([code]) => code),
    BO: ["pricing.cost.read", "equipment.update", "suppliers.credit.manage", "loans.read", "loans.update", "loans.delete", "quotes.approve", "activity.read"],
    SMM: ["pricing.cost.read", "equipment.update", "suppliers.credit.manage", "loans.create", "loans.read", "loans.update", "quotes.approve", "activity.read"],
    SSREP: ["leads.approve", "quotes.approve", "loans.create", "loans.read"],
    SREP: ["loans.create", "loans.read"],
    BOM: ["pricing.cost.read", "equipment.update", "suppliers.credit.manage", "loans.read", "activity.read"],
    PROC: ["pricing.cost.read", "equipment.update"],
    FIN: ["pricing.cost.read", "suppliers.credit.manage", "loans.read", "loans.update", "loans.delete"],
    SYS: ["pricing.cost.read", "equipment.update", "activity.read"],
};

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface) {
        const { sequelize } = queryInterface;
        for (const [code, name, category] of PERMISSIONS) {
            await sequelize.query(
                `INSERT INTO permissions (code, name, category, is_system, created_at, updated_at)
                 VALUES (:code, :name, :category, true, NOW(), NOW())
                 ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category, is_system = true, updated_at = NOW()`,
                { replacements: { code, name, category } }
            );
        }
        // Only on a database whose roles are already seeded (SREP exists). On a
        // brand-new database the seeder creates SSREP with its full default
        // grants — creating it here first would leave it holding only the few
        // codes below, because the seeder skips roles that already have grants.
        const [code, name, description] = SSREP;
        await sequelize.query(
            `INSERT INTO roles (code, name, description, is_system, is_active, created_at, updated_at)
             SELECT :code, :name, :description, true, true, NOW(), NOW()
             WHERE EXISTS (SELECT 1 FROM roles WHERE code = 'SREP')
             ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, is_system = true, updated_at = NOW()`,
            { replacements: { code, name, description } }
        );
        // SSREP starts from SREP's grants (whatever they are on this database).
        await sequelize.query(
            `INSERT INTO role_permissions (role_id, permission_id, created_at, updated_at)
             SELECT s.id, rp.permission_id, NOW(), NOW()
             FROM roles s, roles r
             JOIN role_permissions rp ON rp.role_id = r.id
             WHERE s.code = 'SSREP' AND r.code = 'SREP'
             ON CONFLICT (role_id, permission_id) DO NOTHING`
        );
        for (const [role, codes] of Object.entries(GRANTS)) {
            await sequelize.query(
                `INSERT INTO role_permissions (role_id, permission_id, created_at, updated_at)
                 SELECT r.id, p.id, NOW(), NOW()
                 FROM roles r, permissions p
                 WHERE r.code = :role AND p.code IN (:codes)
                 ON CONFLICT (role_id, permission_id) DO NOTHING`,
                { replacements: { role, codes } }
            );
        }
    },

    async down(queryInterface) {
        const { sequelize } = queryInterface;
        await sequelize.query("DELETE FROM permissions WHERE code IN (:codes)", {
            replacements: { codes: PERMISSIONS.map(([code]) => code) },
        });
        await sequelize.query("UPDATE users SET roles = array_remove(roles, 'SSREP'), updated_at = NOW() WHERE 'SSREP' = ANY(roles)");
        await sequelize.query("DELETE FROM roles WHERE code = 'SSREP'");
    },
};
