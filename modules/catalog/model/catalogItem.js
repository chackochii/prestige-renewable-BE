// A product the quote builder can price: one row per item with its brands
// and unit prices (AUD ex GST) kept as JSONB. Seeded by seeders/catalog-items.cjs.
export default (sequelize, DataTypes) => {
    const CatalogItem = sequelize.define(
        "CatalogItem",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            key: { type: DataTypes.STRING(100), allowNull: false, unique: true },
            name: { type: DataTypes.STRING, allowNull: false },
            unit: { type: DataTypes.STRING(30), allowNull: false, defaultValue: "unit" },
            brands: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] }, // [{ name, unitPrice }]
            isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
            sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        },
        { tableName: "catalog_items" }
    );

    return CatalogItem;
};
