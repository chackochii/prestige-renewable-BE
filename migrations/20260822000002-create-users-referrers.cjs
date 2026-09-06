"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        // users first (referrer_id FK added after referrers exists — circular reference)
        await queryInterface.createTable("users", {
            id: {
                type: Sequelize.INTEGER,
                primaryKey: true,
                allowNull: false,
                autoIncrement: true,
            },
            name: { type: Sequelize.STRING, allowNull: false },
            email: { type: Sequelize.STRING, allowNull: false, unique: true },
            password: { type: Sequelize.STRING, allowNull: false },
            roles: { type: Sequelize.ARRAY(Sequelize.STRING(5)), allowNull: false, defaultValue: [] },
            title: { type: Sequelize.STRING },
            status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "active" },
            referrer_id: { type: Sequelize.INTEGER, allowNull: true },
            created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
            updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
        });

        await queryInterface.createTable("referrers", {
            id: {
                type: Sequelize.INTEGER,
                primaryKey: true,
                allowNull: false,
                autoIncrement: true,
            },
            organisation: { type: Sequelize.STRING, allowNull: false },
            contact_name: { type: Sequelize.STRING },
            email: { type: Sequelize.STRING },
            phone: { type: Sequelize.STRING },
            payment_ref: { type: Sequelize.STRING },
            status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "active" },
            user_id: {
                type: Sequelize.INTEGER,
                allowNull: true,
                references: { model: "users", key: "id" },
                onUpdate: "CASCADE",
                onDelete: "SET NULL",
            },
            created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
            updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
        });

        await queryInterface.addConstraint("users", {
            fields: ["referrer_id"],
            type: "foreign key",
            name: "users_referrer_id_fkey",
            references: { table: "referrers", field: "id" },
            onUpdate: "CASCADE",
            onDelete: "SET NULL",
        });

        await queryInterface.createTable("user_business_units", {
            id: {
                type: Sequelize.INTEGER,
                primaryKey: true,
                allowNull: false,
                autoIncrement: true,
            },
            user_id: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: { model: "users", key: "id" },
                onUpdate: "CASCADE",
                onDelete: "CASCADE",
            },
            business_unit_id: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: { model: "business_units", key: "id" },
                onUpdate: "CASCADE",
                onDelete: "CASCADE",
            },
            created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
            updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
        });

        await queryInterface.addIndex("user_business_units", ["user_id", "business_unit_id"], {
            unique: true,
            name: "user_business_units_user_id_business_unit_id_uq",
        });
    },

    async down(queryInterface) {
        await queryInterface.dropTable("user_business_units");
        await queryInterface.removeConstraint("users", "users_referrer_id_fkey");
        await queryInterface.dropTable("referrers");
        await queryInterface.dropTable("users");
    },
};
