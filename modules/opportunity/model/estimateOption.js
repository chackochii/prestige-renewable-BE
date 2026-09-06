// A system option inside an estimate (e.g. BESS + solar configuration a customer can pick)
export default (sequelize, DataTypes) => {
    const EstimateOption = sequelize.define(
        "EstimateOption",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            estimateId: { type: DataTypes.INTEGER, allowNull: false },
            name: { type: DataTypes.STRING },
            brand: { type: DataTypes.STRING }, // e.g. "Integrated EV-charging + BESS platform"
            product: { type: DataTypes.STRING },
            capacityKw: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
            capacityKwh: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
            costEx: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
            priceEx: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
            margin: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 0 }, // % derived from price/cost
            annualSaving: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
            paybackYears: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
            selected: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        },
        { tableName: "estimate_options" }
    );

    EstimateOption.associate = (db) => {
        EstimateOption.belongsTo(db.Estimate, { foreignKey: "estimateId", as: "estimate" });
    };

    return EstimateOption;
};
