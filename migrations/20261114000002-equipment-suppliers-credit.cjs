"use strict";

// Equipment, suppliers and supplier credit (Nov 2026).
//
//   equipment_categories      equipment and service categories — a category ID
//                             (CAT-001), the kind, active flag; items count
//                             against them.
//   suppliers                 who the business buys from, with their payment
//                             terms and credit limit (the credit details are
//                             management's; see suppliers.credit.manage).
//   equipment                 the items bought and sold: category, SKU, unit,
//                             the margin % applied over the purchase price, and
//                             an optional fixed sales price.
//   equipment_supplier_prices one purchase price per supplier per item. The
//                             preferred supplier's price is the item's cost;
//                             sales price = cost × (1 + margin).
//   supplier_transactions     purchases and payments against a supplier's
//                             account. Outstanding = purchases − payments,
//                             available = limit − outstanding, overdue =
//                             purchases past their due date not yet covered
//                             by payments (oldest first).
//
// The quote builder's catalog_items table is untouched: quotes keep pricing
// from it. Equipment is the business's purchasing and price-list record.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        const timestamps = {
            created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
            updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
        };
        const userRef = { type: Sequelize.INTEGER, allowNull: true, references: { model: "users", key: "id" }, onDelete: "SET NULL" };

        await queryInterface.createTable("equipment_categories", {
            id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            code: { type: Sequelize.STRING(20), allowNull: false, unique: true }, // CAT-001
            name: { type: Sequelize.STRING(120), allowNull: false },
            kind: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "equipment" }, // equipment | service
            description: { type: Sequelize.STRING(500), allowNull: true },
            is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
            sort_order: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
            ...timestamps,
        });
        await queryInterface.sequelize.query(
            "CREATE UNIQUE INDEX equipment_categories_name_kind_uq ON equipment_categories (lower(name), kind)"
        );

        await queryInterface.createTable("suppliers", {
            id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            name: { type: Sequelize.STRING(200), allowNull: false },
            code: { type: Sequelize.STRING(20), allowNull: true }, // SUP-001
            contact_name: { type: Sequelize.STRING(120), allowNull: true },
            email: { type: Sequelize.STRING(254), allowNull: true },
            phone: { type: Sequelize.STRING(30), allowNull: true },
            address: { type: Sequelize.STRING(500), allowNull: true },
            abn: { type: Sequelize.STRING(20), allowNull: true },
            website: { type: Sequelize.STRING(300), allowNull: true },
            payment_terms_days: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 30 },
            credit_limit: { type: Sequelize.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
            credit_notes: { type: Sequelize.TEXT, allowNull: true },
            notes: { type: Sequelize.TEXT, allowNull: true },
            is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
            created_by_id: userRef,
            ...timestamps,
        });
        await queryInterface.sequelize.query("CREATE UNIQUE INDEX suppliers_name_uq ON suppliers (lower(name))");

        await queryInterface.createTable("equipment", {
            id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            category_id: {
                type: Sequelize.INTEGER,
                allowNull: true,
                references: { model: "equipment_categories", key: "id" },
                onDelete: "SET NULL",
            },
            name: { type: Sequelize.STRING(200), allowNull: false },
            sku: { type: Sequelize.STRING(60), allowNull: true },
            brand: { type: Sequelize.STRING(120), allowNull: true },
            model: { type: Sequelize.STRING(120), allowNull: true },
            unit: { type: Sequelize.STRING(30), allowNull: false, defaultValue: "unit" },
            description: { type: Sequelize.TEXT, allowNull: true },
            specifications: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} }, // { watts, kwh, phases, … }
            // Margin over the purchase price, %. Null = the default (EQUIPMENT_DEFAULT_MARGIN_PCT, 20).
            margin_pct: { type: Sequelize.DECIMAL(6, 2), allowNull: true },
            // A fixed sales price instead of cost × margin; null = derived.
            sales_price_override: { type: Sequelize.DECIMAL(12, 2), allowNull: true },
            preferred_supplier_id: {
                type: Sequelize.INTEGER,
                allowNull: true,
                references: { model: "suppliers", key: "id" },
                onDelete: "SET NULL",
            },
            is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
            created_by_id: userRef,
            updated_by_id: userRef,
            ...timestamps,
        });
        await queryInterface.addIndex("equipment", ["category_id"], { name: "equipment_category" });
        await queryInterface.sequelize.query("CREATE UNIQUE INDEX equipment_sku_uq ON equipment (lower(sku)) WHERE sku IS NOT NULL");

        await queryInterface.createTable("equipment_supplier_prices", {
            id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            equipment_id: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: { model: "equipment", key: "id" },
                onDelete: "CASCADE",
            },
            supplier_id: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: { model: "suppliers", key: "id" },
                onDelete: "CASCADE",
            },
            unit_cost: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 }, // AUD ex GST
            supplier_sku: { type: Sequelize.STRING(60), allowNull: true },
            lead_time_days: { type: Sequelize.INTEGER, allowNull: true },
            min_order_qty: { type: Sequelize.INTEGER, allowNull: true },
            valid_from: { type: Sequelize.DATEONLY, allowNull: true },
            valid_to: { type: Sequelize.DATEONLY, allowNull: true },
            notes: { type: Sequelize.STRING(500), allowNull: true },
            // The last few prices, newest first: [{ unitCost, at, byId, byName }].
            price_history: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
            updated_by_id: userRef,
            ...timestamps,
        });
        await queryInterface.addIndex("equipment_supplier_prices", ["equipment_id", "supplier_id"], {
            unique: true,
            name: "equipment_supplier_prices_uq",
        });

        await queryInterface.createTable("supplier_transactions", {
            id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            supplier_id: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: { model: "suppliers", key: "id" },
                onDelete: "CASCADE",
            },
            business_unit_id: {
                type: Sequelize.INTEGER,
                allowNull: true,
                references: { model: "business_units", key: "id" },
                onDelete: "SET NULL",
            },
            opportunity_id: {
                type: Sequelize.INTEGER,
                allowNull: true,
                references: { model: "opportunities", key: "id" },
                onDelete: "SET NULL",
            },
            purchase_order_id: {
                type: Sequelize.INTEGER,
                allowNull: true,
                references: { model: "purchase_orders", key: "id" },
                onDelete: "SET NULL",
            },
            kind: { type: Sequelize.STRING(20), allowNull: false }, // purchase | payment | credit_note
            amount: { type: Sequelize.DECIMAL(14, 2), allowNull: false },
            reference: { type: Sequelize.STRING(120), allowNull: true }, // invoice / receipt number
            transacted_at: { type: Sequelize.DATEONLY, allowNull: false },
            due_at: { type: Sequelize.DATEONLY, allowNull: true }, // purchases: when payment is due
            note: { type: Sequelize.STRING(1000), allowNull: true },
            recorded_by_id: userRef,
            ...timestamps,
        });
        await queryInterface.addIndex("supplier_transactions", ["supplier_id", "transacted_at"], { name: "supplier_transactions_supplier_date" });
    },

    async down(queryInterface) {
        await queryInterface.dropTable("supplier_transactions");
        await queryInterface.dropTable("equipment_supplier_prices");
        await queryInterface.dropTable("equipment");
        await queryInterface.dropTable("suppliers");
        await queryInterface.dropTable("equipment_categories");
    },
};
