export default (sequelize, DataTypes) => {
    const Estimate = sequelize.define(
        "Estimate",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            opportunityId: { type: DataTypes.INTEGER, allowNull: false },
            version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
            issued: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            issuedAt: { type: DataTypes.DATE },
            verifiedById: { type: DataTypes.INTEGER, allowNull: true },
            verifiedAt: { type: DataTypes.DATE },
        },
        {
            tableName: "estimates",
            indexes: [{ unique: true, fields: ["opportunity_id", "version"] }],
        }
    );

    Estimate.associate = (db) => {
        Estimate.belongsTo(db.Opportunity, { foreignKey: "opportunityId", as: "opportunity" });
        Estimate.hasMany(db.EstimateOption, { foreignKey: "estimateId", as: "options" });
        Estimate.belongsTo(db.User, { foreignKey: "verifiedById", as: "verifiedBy" });
    };

    return Estimate;
};
