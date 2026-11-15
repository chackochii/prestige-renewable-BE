// One purchase price per supplier per item (AUD ex GST), with the last few
// prices kept in priceHistory so a change can be seen.
export default (sequelize, DataTypes) => {
    const EquipmentSupplierPrice = sequelize.define(
        "EquipmentSupplierPrice",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            equipmentId: { type: DataTypes.INTEGER, allowNull: false },
            supplierId: { type: DataTypes.INTEGER, allowNull: false },
            unitCost: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
            supplierSku: { type: DataTypes.STRING(60) },
            leadTimeDays: { type: DataTypes.INTEGER },
            minOrderQty: { type: DataTypes.INTEGER },
            validFrom: { type: DataTypes.DATEONLY },
            validTo: { type: DataTypes.DATEONLY },
            notes: { type: DataTypes.STRING(500) },
            priceHistory: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] }, // [{ unitCost, at, byId, byName }]
            updatedById: { type: DataTypes.INTEGER, allowNull: true },
        },
        {
            tableName: "equipment_supplier_prices",
            indexes: [{ unique: true, fields: ["equipment_id", "supplier_id"] }],
        }
    );

    EquipmentSupplierPrice.associate = (db) => {
        EquipmentSupplierPrice.belongsTo(db.Equipment, { foreignKey: "equipmentId", as: "equipment" });
        EquipmentSupplierPrice.belongsTo(db.Supplier, { foreignKey: "supplierId", as: "supplier" });
        EquipmentSupplierPrice.belongsTo(db.User, { foreignKey: "updatedById", as: "updatedBy" });
    };

    return EquipmentSupplierPrice;
};
