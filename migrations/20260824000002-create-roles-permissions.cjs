"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.createTable("roles", {
            id: {
                type: Sequelize.INTEGER,
                primaryKey: true,
                allowNull: false,
                autoIncrement: true,
            },
            code: { type: Sequelize.STRING(5), allowNull: false, unique: true },
            name: { type: Sequelize.STRING, allowNull: false },
            description: { type: Sequelize.STRING },
            created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
            updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
        });

        await queryInterface.createTable("permissions", {
            id: {
                type: Sequelize.INTEGER,
                primaryKey: true,
                allowNull: false,
                autoIncrement: true,
            },
            code: { type: Sequelize.STRING(50), allowNull: false, unique: true },
            name: { type: Sequelize.STRING, allowNull: false },
            category: { type: Sequelize.STRING(30) },
            created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
            updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
        });

        await queryInterface.createTable("role_permissions", {
            id: {
                type: Sequelize.INTEGER,
                primaryKey: true,
                allowNull: false,
                autoIncrement: true,
            },
            role_id: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: { model: "roles", key: "id" },
                onUpdate: "CASCADE",
                onDelete: "CASCADE",
            },
            permission_id: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: { model: "permissions", key: "id" },
                onUpdate: "CASCADE",
                onDelete: "CASCADE",
            },
            created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
            updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
        });

        await queryInterface.addIndex("role_permissions", ["role_id", "permission_id"], {
            unique: true,
            name: "role_permissions_role_id_permission_id_uq",
        });
    },

    async down(queryInterface) {
        await queryInterface.dropTable("role_permissions");
        await queryInterface.dropTable("permissions");
        await queryInterface.dropTable("roles");
    },
};
