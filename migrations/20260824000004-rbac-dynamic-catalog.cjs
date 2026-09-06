"use strict";

// Prepares RBAC for runtime management: role codes wide enough for
// admin-defined roles, protect/retire flags, and single-parent inheritance so
// a future role (e.g. "Director – Business Development / Sales") can extend an
// existing role's grants with one insert instead of a schema change.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        // Widen role-code storage everywhere a code lives (was varchar(5)).
        await queryInterface.sequelize.query(`
            ALTER TABLE roles ALTER COLUMN code TYPE varchar(20);
            ALTER TABLE approvals ALTER COLUMN owner_role DROP DEFAULT;
            ALTER TABLE approvals ALTER COLUMN owner_role TYPE varchar(20);
            ALTER TABLE approvals ALTER COLUMN owner_role SET DEFAULT 'BOP';
            ALTER TABLE users ALTER COLUMN roles DROP DEFAULT;
            ALTER TABLE users ALTER COLUMN roles TYPE varchar(20)[] USING roles::varchar(20)[];
            ALTER TABLE users ALTER COLUMN roles SET DEFAULT '{}'::varchar(20)[];
        `);

        // Seeded rows the application depends on: not deletable via the API.
        await queryInterface.addColumn("roles", "is_system", {
            type: Sequelize.BOOLEAN,
            allowNull: false,
            defaultValue: false,
        });
        // Retire a role without deleting it: unassignable, grants nothing.
        await queryInterface.addColumn("roles", "is_active", {
            type: Sequelize.BOOLEAN,
            allowNull: false,
            defaultValue: true,
        });
        // A role grants its own permissions plus those of its ancestor chain.
        await queryInterface.addColumn("roles", "inherits_from_role_id", {
            type: Sequelize.INTEGER,
            allowNull: true,
            references: { model: "roles", key: "id" },
            onUpdate: "CASCADE",
            onDelete: "SET NULL",
        });
        // System permissions are enforced by requirePermission() calls in code,
        // so their catalog rows must not be deletable; admin-created ones are.
        await queryInterface.addColumn("permissions", "is_system", {
            type: Sequelize.BOOLEAN,
            allowNull: false,
            defaultValue: false,
        });
    },

    async down(queryInterface) {
        await queryInterface.removeColumn("permissions", "is_system");
        await queryInterface.removeColumn("roles", "inherits_from_role_id");
        await queryInterface.removeColumn("roles", "is_active");
        await queryInterface.removeColumn("roles", "is_system");
        await queryInterface.sequelize.query(`
            ALTER TABLE users ALTER COLUMN roles DROP DEFAULT;
            ALTER TABLE users ALTER COLUMN roles TYPE varchar(5)[] USING roles::varchar(5)[];
            ALTER TABLE users ALTER COLUMN roles SET DEFAULT '{}'::varchar(5)[];
            ALTER TABLE approvals ALTER COLUMN owner_role DROP DEFAULT;
            ALTER TABLE approvals ALTER COLUMN owner_role TYPE varchar(5);
            ALTER TABLE approvals ALTER COLUMN owner_role SET DEFAULT 'BOP';
            ALTER TABLE roles ALTER COLUMN code TYPE varchar(5);
        `);
    },
};
