// Scope change after acceptance: re-estimate → priced → presented → accepted
export default (sequelize, DataTypes) => {
    const Variation = sequelize.define(
        "Variation",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            opportunityId: { type: DataTypes.INTEGER, allowNull: false },
            reason: { type: DataTypes.TEXT, allowNull: false },
            status: {
                type: DataTypes.STRING(20),
                allowNull: false,
                defaultValue: "identify",
                validate: { isIn: [["identify", "re-estimate", "priced", "approved", "presented", "accepted"]] },
            },
            createdById: { type: DataTypes.INTEGER, allowNull: true },
            // Price change vs the accepted estimate, in percent. Drives the
            // approval escalation in approvalPolicy.variationApproverRoles:
            // below 5% → SMM; 5% and above → BO + SMM.
            changePercent: { type: DataTypes.DECIMAL(6, 2), allowNull: true },
            // Sign-offs recorded so far: [{ roleCode, userId, at }]
            approvals: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        },
        { tableName: "variations" }
    );

    Variation.associate = (db) => {
        Variation.belongsTo(db.Opportunity, { foreignKey: "opportunityId", as: "opportunity" });
        Variation.belongsTo(db.User, { foreignKey: "createdById", as: "createdBy" });
    };

    return Variation;
};
