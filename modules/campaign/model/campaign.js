// Marketing campaign briefs. A brief must be approved before it becomes a
// lead source; opportunities attribute themselves via campaignId so
// performance (leads, qualified, won, pipeline value) is one query away.
export default (sequelize, DataTypes) => {
    const Campaign = sequelize.define(
        "Campaign",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            businessUnitId: { type: DataTypes.INTEGER, allowNull: false },
            name: { type: DataTypes.STRING, allowNull: false },
            channel: { type: DataTypes.STRING },
            audience: { type: DataTypes.STRING },
            objective: { type: DataTypes.STRING },
            budget: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
            actualSpend: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
            status: {
                type: DataTypes.STRING(20),
                allowNull: false,
                defaultValue: "draft",
                validate: { isIn: [["draft", "approved", "closed"]] },
            },
            ownerId: { type: DataTypes.INTEGER, allowNull: true },
            approverId: { type: DataTypes.INTEGER, allowNull: true },
            approvedAt: { type: DataTypes.DATE },
            startDate: { type: DataTypes.DATEONLY },
            endDate: { type: DataTypes.DATEONLY },
        },
        { tableName: "campaigns" }
    );

    Campaign.associate = (db) => {
        Campaign.belongsTo(db.BusinessUnit, { foreignKey: "businessUnitId", as: "businessUnit" });
        Campaign.belongsTo(db.User, { foreignKey: "ownerId", as: "owner" });
        Campaign.belongsTo(db.User, { foreignKey: "approverId", as: "approver" });
        Campaign.hasMany(db.Opportunity, { foreignKey: "campaignId", as: "opportunities" });
    };

    return Campaign;
};
