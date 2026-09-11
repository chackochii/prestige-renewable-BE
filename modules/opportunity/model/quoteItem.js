// A priced line on a quote. itemKey/itemName/brand/unit/unitPrice are copied
// from the catalog at the time of adding, so later catalog edits do not
// silently reprice an issued quote.
export default (sequelize, DataTypes) => {
    const QuoteItem = sequelize.define(
        "QuoteItem",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            quoteId: { type: DataTypes.INTEGER, allowNull: false },
            itemKey: { type: DataTypes.STRING(100), allowNull: false },
            itemName: { type: DataTypes.STRING, allowNull: false },
            brand: { type: DataTypes.STRING, allowNull: false },
            unit: { type: DataTypes.STRING(30) },
            quantity: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 1 },
            unitPrice: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
            discountPct: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
            sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        },
        { tableName: "quote_items", indexes: [{ fields: ["quote_id"] }] }
    );

    QuoteItem.associate = (db) => {
        QuoteItem.belongsTo(db.Quote, { foreignKey: "quoteId", as: "quote" });
    };

    return QuoteItem;
};
