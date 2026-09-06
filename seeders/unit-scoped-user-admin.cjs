"use strict";

// Grants DIR user.manage on databases seeded before directors could manage
// users (fresh installs get the grant from roles-permissions.cjs, whose
// default-grant pass skips roles that already hold grants). For a non-ADM
// role, user.manage is unit-scoped in userService: directors manage users
// within their own business units only, and can never touch or create
// administrator accounts.
//
// Runs after roles-permissions.cjs under db:seed:all (filename order); a
// no-op when the role, the permission or the grant already/never exists.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface) {
        await queryInterface.sequelize.query(`
            INSERT INTO role_permissions (role_id, permission_id, created_at, updated_at)
            SELECT r.id, p.id, NOW(), NOW()
            FROM roles r, permissions p
            WHERE r.code = 'DIR' AND p.code = 'user.manage'
            ON CONFLICT (role_id, permission_id) DO NOTHING
        `);
    },

    async down(queryInterface) {
        await queryInterface.sequelize.query(`
            DELETE FROM role_permissions
            WHERE role_id = (SELECT id FROM roles WHERE code = 'DIR')
              AND permission_id = (SELECT id FROM permissions WHERE code = 'user.manage')
        `);
    },
};
