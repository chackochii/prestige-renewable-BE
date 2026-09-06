// Milestone billing raised against an opportunity. Milestones come from the
// unit's billingSplit config (e.g. deposit 20% → delivery 40% → final 40%).
export default (sequelize, DataTypes) => {
    const BillingRequest = sequelize.define(
        "BillingRequest",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            opportunityId: { type: DataTypes.INTEGER, allowNull: false },
            // Validated against the unit's billingSplit keys at the service layer
            milestone: { type: DataTypes.STRING(20), allowNull: false },
            percent: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
            amountEx: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
            gst: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
            status: {
                type: DataTypes.STRING(20),
                allowNull: false,
                defaultValue: "requested",
                validate: { isIn: [["requested", "invoiced", "cancelled"]] },
            },
            invoiceNumber: { type: DataTypes.STRING },
            paymentStatus: {
                type: DataTypes.STRING(20),
                allowNull: false,
                defaultValue: "unpaid",
                validate: { isIn: [["unpaid", "paid"]] },
            },
            // What triggered the request, e.g. "Deposit on acceptance", "Delivery to site"
            event: { type: DataTypes.STRING },
        },
        {
            tableName: "billing_requests",
            indexes: [{ fields: ["opportunity_id"] }],
        }
    );

    BillingRequest.associate = (db) => {
        BillingRequest.belongsTo(db.Opportunity, { foreignKey: "opportunityId", as: "opportunity" });
    };

    return BillingRequest;
};
