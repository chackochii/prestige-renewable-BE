// The quote built at the estimation stage: one per opportunity, with priced
// line items (quote_items) and additional costs (quote_costs). Totals and GST
// are derived by the client from these rows, never stored.
export const PROJECT_TYPES = ["Solar", "Battery", "Solar + Battery", "Other"];
export const TAX_TREATMENTS = ["exclusive", "inclusive", "no_gst"];

export default (sequelize, DataTypes) => {
    const Quote = sequelize.define(
        "Quote",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            opportunityId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
            quoteNumber: { type: DataTypes.STRING(40), allowNull: false }, // e.g. PRS-Q-26-0008
            project: { type: DataTypes.STRING },
            projectType: {
                type: DataTypes.STRING(40),
                allowNull: false,
                defaultValue: "Solar",
                validate: { isIn: [PROJECT_TYPES] },
            },
            projectTypeOther: { type: DataTypes.STRING },
            quoteDate: { type: DataTypes.DATEONLY },
            taxTreatment: {
                type: DataTypes.STRING(20),
                allowNull: false,
                defaultValue: "exclusive",
                validate: { isIn: [TAX_TREATMENTS] },
            },
            gstRatePct: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 10 },
            createdById: { type: DataTypes.INTEGER, allowNull: true },
        },
        { tableName: "quotes" }
    );

    Quote.associate = (db) => {
        Quote.belongsTo(db.Opportunity, { foreignKey: "opportunityId", as: "opportunity" });
        Quote.belongsTo(db.User, { foreignKey: "createdById", as: "createdBy" });
        Quote.hasMany(db.QuoteItem, { foreignKey: "quoteId", as: "items" });
        Quote.hasMany(db.QuoteCost, { foreignKey: "quoteId", as: "additionalCosts" });
    };

    return Quote;
};
