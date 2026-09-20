// A frozen copy of the quote as it stood when it was issued. The PDF is
// rebuilt from `snapshot` whenever somebody views or downloads the version,
// so nothing else about it needs storing.
export default (sequelize, DataTypes) => {
    const QuoteVersion = sequelize.define(
        "QuoteVersion",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            quoteId: { type: DataTypes.INTEGER, allowNull: false },
            opportunityId: { type: DataTypes.INTEGER, allowNull: false },
            // Server-owned: the next number for this quote. Unique per quote.
            version: { type: DataTypes.INTEGER, allowNull: false },
            quoteNumber: { type: DataTypes.STRING(40) },
            invoiceNumber: { type: DataTypes.STRING(40) },
            grandTotal: { type: DataTypes.DECIMAL(14, 2) },
            snapshot: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
            createdById: { type: DataTypes.INTEGER },
        },
        {
            tableName: "quote_versions",
            indexes: [
                { fields: ["opportunity_id", "created_at"] },
                { fields: ["quote_id", "version"], unique: true },
            ],
        }
    );

    QuoteVersion.associate = (db) => {
        QuoteVersion.belongsTo(db.Quote, { foreignKey: "quoteId", as: "quote" });
        QuoteVersion.belongsTo(db.Opportunity, { foreignKey: "opportunityId", as: "opportunity" });
        QuoteVersion.belongsTo(db.User, { foreignKey: "createdById", as: "createdBy" });
    };

    return QuoteVersion;
};
