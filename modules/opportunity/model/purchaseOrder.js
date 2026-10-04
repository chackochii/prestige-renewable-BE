// A purchase order on a job (procurement & delivery, stage 6): drafted while
// the price variation is cleared, sent to the supplier once it may be, then
// confirmed, scheduled for delivery and received on site. `lines` are the
// keys of the BOQ lines it covers (procurement_jobs.boq).
export const PURCHASE_ORDER_STATUSES = ["draft", "sent", "confirmed", "scheduled", "delivered"];

export default (sequelize, DataTypes) => {
    const PurchaseOrder = sequelize.define(
        "PurchaseOrder",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            opportunityId: { type: DataTypes.INTEGER, allowNull: false },
            ref: { type: DataTypes.STRING, allowNull: false }, // the PO number, e.g. PO-26-0112
            supplier: { type: DataTypes.STRING }, // e.g. "Atlas Storage APAC"
            items: { type: DataTypes.TEXT }, // free-text description, kept for older rows
            lines: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
            amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
            eta: { type: DataTypes.DATEONLY }, // the supplier's delivery estimate
            scheduledFor: { type: DataTypes.DATEONLY }, // the delivery slot agreed with site
            status: {
                type: DataTypes.STRING(20),
                allowNull: false,
                defaultValue: "draft",
                validate: { isIn: [PURCHASE_ORDER_STATUSES] },
            },
            sentAt: { type: DataTypes.DATE },
            confirmedAt: { type: DataTypes.DATE },
            deliveredAt: { type: DataTypes.DATE },
            receivedBy: { type: DataTypes.STRING(120) },
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
