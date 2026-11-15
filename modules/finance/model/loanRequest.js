// A finance application raised by sales on a lead and reviewed by finance.
// The customer's details are copied from the lead when the request is made,
// so the application reads as it was submitted even if the lead changes.
export const LOAN_STATUSES = ["submitted", "under_review", "more_info", "approved", "declined", "withdrawn"];
/** Still being worked: finance has not answered. */
export const OPEN_LOAN_STATUSES = ["submitted", "under_review", "more_info"];

export default (sequelize, DataTypes) => {
    const LoanRequest = sequelize.define(
        "LoanRequest",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            opportunityId: { type: DataTypes.INTEGER, allowNull: false },
            businessUnitId: { type: DataTypes.INTEGER, allowNull: false },
            number: { type: DataTypes.STRING(30) }, // LN-26-0001
            customerName: { type: DataTypes.STRING(255) },
            customerEmail: { type: DataTypes.STRING(254) },
            customerPhone: { type: DataTypes.STRING(30) },
            customerAddress: { type: DataTypes.STRING(500) },
            loanAmount: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
            depositAmount: { type: DataTypes.DECIMAL(14, 2) },
            termMonths: { type: DataTypes.INTEGER },
            financier: { type: DataTypes.STRING(120) },
            salesRepId: { type: DataTypes.INTEGER, allowNull: true },
            submittedById: { type: DataTypes.INTEGER, allowNull: true },
            applicationDate: { type: DataTypes.DATEONLY, allowNull: false },
            status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "submitted", validate: { isIn: [LOAN_STATUSES] } },
            reviewedById: { type: DataTypes.INTEGER, allowNull: true },
            decidedAt: { type: DataTypes.DATE },
            financierReference: { type: DataTypes.STRING(120) },
            financierResponse: { type: DataTypes.TEXT },
            financierResponseAt: { type: DataTypes.DATE },
            notes: { type: DataTypes.TEXT },
        },
        { tableName: "loan_requests", paranoid: true }
    );

    LoanRequest.associate = (db) => {
        LoanRequest.belongsTo(db.Opportunity, { foreignKey: "opportunityId", as: "opportunity" });
        LoanRequest.belongsTo(db.BusinessUnit, { foreignKey: "businessUnitId", as: "businessUnit" });
        LoanRequest.belongsTo(db.User, { foreignKey: "salesRepId", as: "salesRep" });
        LoanRequest.belongsTo(db.User, { foreignKey: "submittedById", as: "submittedBy" });
        LoanRequest.belongsTo(db.User, { foreignKey: "reviewedById", as: "reviewedBy" });
        LoanRequest.hasMany(db.LoanRequestMessage, { foreignKey: "loanRequestId", as: "messages" });
    };

    return LoanRequest;
};
