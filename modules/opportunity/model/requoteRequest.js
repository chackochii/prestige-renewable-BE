// A round of re-quoting: the customer asked for changes to their proposal and
// sales sent the job back to estimation with the customer's message and their
// own comments. Open while the estimator has it; completed when the revised
// quote is handed back to proposal (see requoteService).
export const REQUOTE_STATUSES = ["open", "completed"];

export default (sequelize, DataTypes) => {
    const RequoteRequest = sequelize.define(
        "RequoteRequest",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            opportunityId: { type: DataTypes.INTEGER, allowNull: false },
            round: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
            status: {
                type: DataTypes.STRING(20),
                allowNull: false,
                defaultValue: "open",
                validate: { isIn: [REQUOTE_STATUSES] },
            },

            // The proposal the customer answered and the saved quote they saw.
            proposalId: { type: DataTypes.INTEGER, allowNull: true },
            quoteVersionId: { type: DataTypes.INTEGER, allowNull: true },

            // What the customer asked for, and how it reached us: customer
            // (through their link), staff (recorded by sales after a call) or
            // null (typed by sales when raising the re-quote).
            customerMessage: { type: DataTypes.TEXT },
            customerName: { type: DataTypes.STRING(120) },
            customerChannel: { type: DataTypes.STRING(20), validate: { isIn: [["customer", "staff"]] } },
            customerRespondedAt: { type: DataTypes.DATE },

            // Sales' instructions to the estimator.
            comments: { type: DataTypes.TEXT, allowNull: false },
            requestedById: { type: DataTypes.INTEGER, allowNull: true },
            estimatorId: { type: DataTypes.INTEGER, allowNull: true },

            // The estimator's hand-back: what changed, and the version it became.
            completedAt: { type: DataTypes.DATE },
            completedById: { type: DataTypes.INTEGER, allowNull: true },
            estimatorNote: { type: DataTypes.TEXT },
            revisedQuoteVersionId: { type: DataTypes.INTEGER, allowNull: true },
        },
        {
            tableName: "requote_requests",
            indexes: [{ fields: ["opportunity_id", "created_at"] }, { fields: ["opportunity_id", "status"] }],
        }
    );

    RequoteRequest.associate = (db) => {
        RequoteRequest.belongsTo(db.Opportunity, { foreignKey: "opportunityId", as: "opportunity" });
        RequoteRequest.belongsTo(db.Proposal, { foreignKey: "proposalId", as: "proposal" });
        RequoteRequest.belongsTo(db.QuoteVersion, { foreignKey: "quoteVersionId", as: "quoteVersion" });
        RequoteRequest.belongsTo(db.QuoteVersion, { foreignKey: "revisedQuoteVersionId", as: "revisedQuoteVersion" });
        RequoteRequest.belongsTo(db.User, { foreignKey: "requestedById", as: "requestedBy" });
        RequoteRequest.belongsTo(db.User, { foreignKey: "estimatorId", as: "estimator" });
        RequoteRequest.belongsTo(db.User, { foreignKey: "completedById", as: "completedBy" });
    };

    return RequoteRequest;
};
