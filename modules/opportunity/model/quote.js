// The quote built at the estimation stage: one per opportunity, with priced
// line items (quote_items) and additional costs (quote_costs). Totals and GST
// are derived by the client from these rows, never stored.
//
// It is a `draft` while it is being built (every edit saves straight away)
// and `generated` once it has been frozen as a version — locked, nothing on
// it can change. A new quote takes the lock off again (quoteService).
export const PROJECT_TYPES = ["Solar", "Battery", "Solar + Battery", "EV", "Other"];
export const TAX_TREATMENTS = ["exclusive", "inclusive", "no_gst"];
export const QUOTE_STATUSES = ["draft", "generated"];

export default (sequelize, DataTypes) => {
    const Quote = sequelize.define(
        "Quote",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            opportunityId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
            quoteNumber: { type: DataTypes.STRING(40), allowNull: false }, // e.g. PRS-Q-26-0008
            project: { type: DataTypes.STRING },
            // Null until the estimator picks one ("Select from options").
            projectType: {
                type: DataTypes.STRING(40),
                allowNull: true,
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
            status: {
                type: DataTypes.STRING(20),
                allowNull: false,
                defaultValue: "draft",
                validate: { isIn: [QUOTE_STATUSES] },
            },
            generatedAt: { type: DataTypes.DATE, allowNull: true },
            generatedVersionId: { type: DataTypes.INTEGER, allowNull: true }, // the version it is locked to
            createdById: { type: DataTypes.INTEGER, allowNull: true },
        },
        { tableName: "quotes" }
    );

    Quote.associate = (db) => {
        Quote.belongsTo(db.Opportunity, { foreignKey: "opportunityId", as: "opportunity" });
        Quote.belongsTo(db.User, { foreignKey: "createdById", as: "createdBy" });
        Quote.hasMany(db.QuoteItem, { foreignKey: "quoteId", as: "items" });
        Quote.hasMany(db.QuoteCost, { foreignKey: "quoteId", as: "additionalCosts" });
        Quote.belongsTo(db.QuoteVersion, { foreignKey: "generatedVersionId", as: "generatedVersion", constraints: false });
    };

    return Quote;
};
