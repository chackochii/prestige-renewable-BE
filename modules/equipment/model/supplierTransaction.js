// A purchase (what the business owes the supplier), a payment (what it has
// paid) or a credit note against a supplier's account. The account's
// outstanding balance, available credit and overdue amount are worked out from
// these rows (supplierCreditService).
export const TRANSACTION_KINDS = ["purchase", "payment", "credit_note"];

export default (sequelize, DataTypes) => {
    const SupplierTransaction = sequelize.define(
        "SupplierTransaction",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            supplierId: { type: DataTypes.INTEGER, allowNull: false },
            businessUnitId: { type: DataTypes.INTEGER, allowNull: true },
            opportunityId: { type: DataTypes.INTEGER, allowNull: true },
            purchaseOrderId: { type: DataTypes.INTEGER, allowNull: true },
            kind: { type: DataTypes.STRING(20), allowNull: false, validate: { isIn: [TRANSACTION_KINDS] } },
            amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
            reference: { type: DataTypes.STRING(120) },
            transactedAt: { type: DataTypes.DATEONLY, allowNull: false },
            dueAt: { type: DataTypes.DATEONLY },
            note: { type: DataTypes.STRING(1000) },
            recordedById: { type: DataTypes.INTEGER, allowNull: true },
        },
        { tableName: "supplier_transactions" }
    );

    SupplierTransaction.associate = (db) => {
        SupplierTransaction.belongsTo(db.Supplier, { foreignKey: "supplierId", as: "supplier" });
        SupplierTransaction.belongsTo(db.BusinessUnit, { foreignKey: "businessUnitId", as: "businessUnit" });
        SupplierTransaction.belongsTo(db.Opportunity, { foreignKey: "opportunityId", as: "opportunity" });
        SupplierTransaction.belongsTo(db.PurchaseOrder, { foreignKey: "purchaseOrderId", as: "purchaseOrder" });
        SupplierTransaction.belongsTo(db.User, { foreignKey: "recordedById", as: "recordedBy" });
    };

    return SupplierTransaction;
};
