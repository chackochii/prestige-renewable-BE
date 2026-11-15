// What a customer owes on a job, GST included, and what has been received
// against it. The status is derived from the receipts and the due date on
// every write (customerPaymentService.statusOf).
export const PAYMENT_STATUSES = ["unpaid", "partial", "paid", "overdue", "cancelled"];
export const RECEIPT_METHODS = ["bank_transfer", "card", "cash", "cheque", "finance", "other"];

export default (sequelize, DataTypes) => {
    const CustomerPayment = sequelize.define(
        "CustomerPayment",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            opportunityId: { type: DataTypes.INTEGER, allowNull: false },
            businessUnitId: { type: DataTypes.INTEGER, allowNull: false },
            projectId: { type: DataTypes.INTEGER, allowNull: true },
            description: { type: DataTypes.STRING(255), allowNull: false },
            milestone: { type: DataTypes.STRING(40) },
            amountEx: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
            gstRatePct: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 10 },
            gstAmount: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
            amountInc: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
            dueAt: { type: DataTypes.DATEONLY },
            invoiceNumber: { type: DataTypes.STRING(60) },
            status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "unpaid", validate: { isIn: [PAYMENT_STATUSES] } },
            receipts: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
            notes: { type: DataTypes.TEXT },
            createdById: { type: DataTypes.INTEGER, allowNull: true },
        },
        { tableName: "customer_payments" }
    );

    CustomerPayment.associate = (db) => {
        CustomerPayment.belongsTo(db.Opportunity, { foreignKey: "opportunityId", as: "opportunity" });
        CustomerPayment.belongsTo(db.BusinessUnit, { foreignKey: "businessUnitId", as: "businessUnit" });
        CustomerPayment.belongsTo(db.Project, { foreignKey: "projectId", as: "project" });
        CustomerPayment.belongsTo(db.User, { foreignKey: "createdById", as: "createdBy" });
    };

    return CustomerPayment;
};
