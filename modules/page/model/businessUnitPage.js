// Per-unit page override. No row = the page is enabled for the unit, so new
// pages default on everywhere; a row with enabled=false turns it off.
export default (sequelize, DataTypes) => {
    const BusinessUnitPage = sequelize.define(
        "BusinessUnitPage",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            businessUnitId: { type: DataTypes.INTEGER, allowNull: false },
            pageId: { type: DataTypes.INTEGER, allowNull: false },
            enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        },
        {
            tableName: "business_unit_pages",
            indexes: [{ unique: true, fields: ["business_unit_id", "page_id"] }],
        }
    );

    BusinessUnitPage.associate = (db) => {
        BusinessUnitPage.belongsTo(db.AppPage, { foreignKey: "pageId", as: "page" });
        BusinessUnitPage.belongsTo(db.BusinessUnit, { foreignKey: "businessUnitId", as: "businessUnit" });
    };

    return BusinessUnitPage;
};
