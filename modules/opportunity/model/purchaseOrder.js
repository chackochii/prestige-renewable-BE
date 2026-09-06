export default (sequelize, DataTypes) => {
    const PurchaseOrder = sequelize.define(
        "PurchaseOrder",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            opportunityId: { type: DataTypes.INTEGER, allowNull: false },
            ref: { type: DataTypes.STRING, allowNull: false },
            supplier: { type: DataTypes.STRING }, // e.g. "Atlas Storage APAC"
            items: { type: DataTypes.TEXT },
            amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
            eta: { type: DataTypes.DATEONLY },
            status: {
                type: DataTypes.STRING(20),
                allowNull: false,
                defaultValue: "sent",
                validate: { isIn: [["sent", "confirmed", "delivered"]] },
            },
            confirmedAt: { type: DataTypes.DATE },
            deliveredAt: { type: DataTypes.DATE },
            deliveryEvidence: { type: DataTypes.STRING },
            confirmingUserId: { type: DataTypes.INTEGER, allowNull: true },
            createdById: { type: DataTypes.INTEGER, allowNull: true },
            // Approval must come from someone other than createdById —
            // enforced via approvalPolicy.assertNotPurchaseOrderSelfApproval.
            approvedById: { type: DataTypes.INTEGER, allowNull: true },
            approvedAt: { type: DataTypes.DATE },
        },
        { tableName: "purchase_orders" }
    );

    PurchaseOrder.associate = (db) => {
        PurchaseOrder.belongsTo(db.Opportunity, { foreignKey: "opportunityId", as: "opportunity" });
        PurchaseOrder.belongsTo(db.User, { foreignKey: "confirmingUserId", as: "confirmingUser" });
        PurchaseOrder.belongsTo(db.User, { foreignKey: "createdById", as: "createdBy" });
        PurchaseOrder.belongsTo(db.User, { foreignKey: "approvedById", as: "approvedBy" });
    };

    return PurchaseOrder;
};
