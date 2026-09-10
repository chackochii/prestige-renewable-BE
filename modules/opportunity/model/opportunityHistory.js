// Job history on an opportunity: notes people add on the History tab plus
// system events the API records itself (assignments, hand-offs). Append-only
// from the API's point of view — there is no update or delete endpoint.
export const HISTORY_KINDS = ["note", "system"];

export default (sequelize, DataTypes) => {
    const OpportunityHistory = sequelize.define(
        "OpportunityHistory",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            opportunityId: { type: DataTypes.INTEGER, allowNull: false },
            authorId: { type: DataTypes.INTEGER, allowNull: true }, // null once the author is deleted
            kind: {
                type: DataTypes.STRING(20),
                allowNull: false,
                defaultValue: "note",
                validate: { isIn: [HISTORY_KINDS] },
            },
            note: { type: DataTypes.TEXT, allowNull: false, validate: { len: [1, 5000] } },
        },
        {
            tableName: "opportunity_history",
            indexes: [{ fields: ["opportunity_id", "created_at"] }],
        }
    );

    OpportunityHistory.associate = (db) => {
        OpportunityHistory.belongsTo(db.Opportunity, { foreignKey: "opportunityId", as: "opportunity" });
        OpportunityHistory.belongsTo(db.User, { foreignKey: "authorId", as: "author" });
    };

    return OpportunityHistory;
};
