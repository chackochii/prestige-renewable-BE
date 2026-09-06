export default (sequelize, DataTypes) => {
    const Referrer = sequelize.define(
        "Referrer",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            organisation: { type: DataTypes.STRING, allowNull: false },
            contactName: { type: DataTypes.STRING },
            email: { type: DataTypes.STRING, validate: { isEmail: true } },
            phone: { type: DataTypes.STRING },
            paymentRef: { type: DataTypes.STRING }, // e.g. "BSB 062-000 · ****4418"
            status: {
                type: DataTypes.STRING(20),
                allowNull: false,
                defaultValue: "active",
                validate: { isIn: [["active", "inactive"]] },
            },
            // Portal login for this referrer, if one exists
            userId: { type: DataTypes.INTEGER, allowNull: true },
        },
        {
            tableName: "referrers",
            paranoid: true, // soft delete — destroy() sets deleted_at, queries exclude deleted rows
        }
    );

    Referrer.associate = (db) => {
        Referrer.belongsTo(db.User, { foreignKey: "userId", as: "portalUser" });
        Referrer.hasMany(db.Opportunity, { foreignKey: "referrerId", as: "opportunities" });
    };

    return Referrer;
};
