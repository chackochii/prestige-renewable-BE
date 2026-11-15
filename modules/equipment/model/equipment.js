// An item the business buys and sells. Its cost is the preferred supplier's
// price (else the lowest); the sales price is cost × (1 + margin %) unless a
// fixed sales price is set. Who may see the cost and margin is decided per
// caller (pricing.cost.read) — equipmentService.presentEquipment.
export default (sequelize, DataTypes) => {
    const Equipment = sequelize.define(
        "Equipment",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            categoryId: { type: DataTypes.INTEGER, allowNull: true },
            name: { type: DataTypes.STRING(200), allowNull: false },
            sku: { type: DataTypes.STRING(60) },
            brand: { type: DataTypes.STRING(120) },
            model: { type: DataTypes.STRING(120) },
            unit: { type: DataTypes.STRING(30), allowNull: false, defaultValue: "unit" },
            description: { type: DataTypes.TEXT },
            specifications: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
            marginPct: { type: DataTypes.DECIMAL(6, 2), allowNull: true },
            salesPriceOverride: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
            preferredSupplierId: { type: DataTypes.INTEGER, allowNull: true },
            isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
            createdById: { type: DataTypes.INTEGER, allowNull: true },
            updatedById: { type: DataTypes.INTEGER, allowNull: true },
        },
        { tableName: "equipment" }
    );

    Equipment.associate = (db) => {
        Equipment.belongsTo(db.EquipmentCategory, { foreignKey: "categoryId", as: "category" });
        Equipment.belongsTo(db.Supplier, { foreignKey: "preferredSupplierId", as: "preferredSupplier" });
        Equipment.hasMany(db.EquipmentSupplierPrice, { foreignKey: "equipmentId", as: "supplierPrices" });
    };

    return Equipment;
};
