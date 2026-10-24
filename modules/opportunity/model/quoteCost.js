// An additional cost on a quote (transport, installation, civil work, …):
// either a fixed amount or a percentage of the items subtotal. `kind` is the
// quote builder's section — a cost adds to the quote, a rebate or a discount
// takes money off it (prestige-fe constants/catalog.js COST_KINDS). A line
// starts with no cost type until the estimator picks one.
export const COST_CALC_TYPES = ["fixed", "percentage"];
export const COST_KINDS = ["cost", "rebate", "discount"];

export default (sequelize, DataTypes) => {
    const QuoteCost = sequelize.define(
        "QuoteCost",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            quoteId: { type: DataTypes.INTEGER, allowNull: false },
            kind: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "cost", validate: { isIn: [COST_KINDS] } },
            costType: { type: DataTypes.STRING(50), allowNull: false, defaultValue: "" },
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
