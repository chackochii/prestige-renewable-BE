// Government / network rebates, e.g. "STC / small-scale", "NSW Peak Demand Reduction"
export default (sequelize, DataTypes) => {
    const Rebate = sequelize.define(
        "Rebate",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            opportunityId: { type: DataTypes.INTEGER, allowNull: false },
            type: { type: DataTypes.STRING, allowNull: false },
            value: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
            status: {
                type: DataTypes.STRING(20),
                allowNull: false,
                defaultValue: "Not lodged",
                validate: { isIn: [["Not lodged", "Lodged", "Approved", "Paid"]] },
            },
            lodgedAt: { type: DataTypes.DATE },
            reference: { type: DataTypes.STRING }, // e.g. STC-88421
        },
        { tableName: "rebates" }
    );

    Rebate.associate = (db) => {
        Rebate.belongsTo(db.Opportunity, { foreignKey: "opportunityId", as: "opportunity" });
    };

    return Rebate;
};
