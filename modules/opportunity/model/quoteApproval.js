// A Senior Sales Representative's review of a quote version before it goes to
// the customer. One row per submission: pending (first submission) or
// resubmitted (after a rejection), then approved or rejected with comments.
// The approver, the date and the comments are kept for good.
export const QUOTE_APPROVAL_STATUSES = ["pending", "approved", "rejected", "resubmitted"];
/** Waiting on the approver. */
export const AWAITING_STATUSES = ["pending", "resubmitted"];

export default (sequelize, DataTypes) => {
    const QuoteApproval = sequelize.define(
        "QuoteApproval",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            opportunityId: { type: DataTypes.INTEGER, allowNull: false },
            businessUnitId: { type: DataTypes.INTEGER, allowNull: false },
            quoteId: { type: DataTypes.INTEGER, allowNull: true },
            quoteVersionId: { type: DataTypes.INTEGER, allowNull: false },
            round: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
            status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "pending", validate: { isIn: [QUOTE_APPROVAL_STATUSES] } },
            submittedById: { type: DataTypes.INTEGER, allowNull: true },
            submittedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
            submissionNote: { type: DataTypes.STRING(2000) },
            approverId: { type: DataTypes.INTEGER, allowNull: true },
            decidedAt: { type: DataTypes.DATE },
            comments: { type: DataTypes.STRING(4000) },
        },
        { tableName: "quote_approvals" }
    );

    QuoteApproval.associate = (db) => {
        QuoteApproval.belongsTo(db.Opportunity, { foreignKey: "opportunityId", as: "opportunity" });
        QuoteApproval.belongsTo(db.BusinessUnit, { foreignKey: "businessUnitId", as: "businessUnit" });
        QuoteApproval.belongsTo(db.Quote, { foreignKey: "quoteId", as: "quote" });
        QuoteApproval.belongsTo(db.QuoteVersion, { foreignKey: "quoteVersionId", as: "quoteVersion" });
        QuoteApproval.belongsTo(db.User, { foreignKey: "submittedById", as: "submittedBy" });
        QuoteApproval.belongsTo(db.User, { foreignKey: "approverId", as: "approver" });
    };

    return QuoteApproval;
};
