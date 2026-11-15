// Who the business buys from. Contact details are anyone's to edit with
// equipment.update; the credit details (limit, terms) are management's
// (suppliers.credit.manage). Purchases and payments against the account are
// supplier_transactions.
export default (sequelize, DataTypes) => {
    const Supplier = sequelize.define(
        "Supplier",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            name: { type: DataTypes.STRING(200), allowNull: false },
            code: { type: DataTypes.STRING(20) }, // SUP-001
            contactName: { type: DataTypes.STRING(120) },
            email: { type: DataTypes.STRING(254) },
            phone: { type: DataTypes.STRING(30) },
            address: { type: DataTypes.STRING(500) },
            abn: { type: DataTypes.STRING(20) },
            website: { type: DataTypes.STRING(300) },
            paymentTermsDays: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 30 },
            creditLimit: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
            creditNotes: { type: DataTypes.TEXT },
            notes: { type: DataTypes.TEXT },
            isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
            createdById: { type: DataTypes.INTEGER, allowNull: true },
        },
        { tableName: "suppliers" }
    );

    Supplier.associate = (db) => {
        Supplier.hasMany(db.EquipmentSupplierPrice, { foreignKey: "supplierId", as: "prices" });
        Supplier.hasMany(db.SupplierTransaction, { foreignKey: "supplierId", as: "transactions" });
        Supplier.belongsTo(db.User, { foreignKey: "createdById", as: "createdBy" });
    };

    return Supplier;
};
