export default (sequelize, DataTypes) => {
    const Proposal = sequelize.define(
        "Proposal",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            opportunityId: { type: DataTypes.INTEGER, allowNull: false },
            number: { type: DataTypes.STRING(30) }, // e.g. PRS-P-0008-v2
            version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
            estimateVersion: { type: DataTypes.INTEGER }, // estimate version this proposal was built from
            status: {
                type: DataTypes.STRING(20),
                allowNull: false,
                defaultValue: "draft",
                validate: { isIn: [["draft", "pending_director", "issued", "presented", "accepted", "rejected", "re-estimated"]] },
            },
            priceEx: { type: DataTypes.DECIMAL(14, 2) },
            margin: { type: DataTypes.DECIMAL(5, 2) },
            issuedAt: { type: DataTypes.DATE },
            presentedAt: { type: DataTypes.DATE },
            acceptedAt: { type: DataTypes.DATE },
            // Director sign-off for below-floor pricing
            directorApprovalStatus: {
                type: DataTypes.STRING(20),
                allowNull: true,
                validate: { isIn: [["pending", "approved", "rejected"]] },
            },
            directorApprovalById: { type: DataTypes.INTEGER, allowNull: true },
            directorApprovalAt: { type: DataTypes.DATE },
            directorApprovalNote: { type: DataTypes.TEXT },
            signedDocName: { type: DataTypes.STRING },
            rejectionReason: { type: DataTypes.TEXT },
        },
        {
            tableName: "proposals",
            indexes: [{ unique: true, fields: ["opportunity_id", "version"] }],
        }
    );

    Proposal.associate = (db) => {
        Proposal.belongsTo(db.Opportunity, { foreignKey: "opportunityId", as: "opportunity" });
        Proposal.belongsTo(db.User, { foreignKey: "directorApprovalById", as: "directorApprovalBy" });
    };

    return Proposal;
};
