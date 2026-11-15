// The conversation on a loan request: finance replying to the representative,
// the representative answering, and the status changes and financier
// responses recorded along the way.
export const LOAN_MESSAGE_KINDS = ["reply", "status", "financier"];

export default (sequelize, DataTypes) => {
    const LoanRequestMessage = sequelize.define(
        "LoanRequestMessage",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            loanRequestId: { type: DataTypes.INTEGER, allowNull: false },
            authorId: { type: DataTypes.INTEGER, allowNull: true },
            kind: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "reply", validate: { isIn: [LOAN_MESSAGE_KINDS] } },
            body: { type: DataTypes.TEXT, allowNull: false },
        },
        { tableName: "loan_request_messages", updatedAt: false }
    );

    LoanRequestMessage.associate = (db) => {
        LoanRequestMessage.belongsTo(db.LoanRequest, { foreignKey: "loanRequestId", as: "loanRequest" });
        LoanRequestMessage.belongsTo(db.User, { foreignKey: "authorId", as: "author" });
    };

    return LoanRequestMessage;
};
