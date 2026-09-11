// An additional cost on a quote (transport, installation, civil work, …):
// either a fixed amount or a percentage of the items subtotal.
export const COST_CALC_TYPES = ["fixed", "percentage"];

export default (sequelize, DataTypes) => {
    const QuoteCost = sequelize.define(
        "QuoteCost",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            quoteId: { type: DataTypes.INTEGER, allowNull: false },
            costType: { type: DataTypes.STRING(50), allowNull: false },
            calcType: {
                type: DataTypes.STRING(20),
                allowNull: false,
                defaultValue: "fixed",
                validate: { isIn: [COST_CALC_TYPES] },
            },
            value: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
            description: { type: DataTypes.STRING(500) },
            sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        },
        { tableName: "quote_costs", indexes: [{ fields: ["quote_id"] }] }
    );

    QuoteCost.associate = (db) => {
        QuoteCost.belongsTo(db.Quote, { foreignKey: "quoteId", as: "quote" });
    };

    return QuoteCost;
};
