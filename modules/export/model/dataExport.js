// One row per Excel download of job data (modules/export). The newest
// fullBackup row for a business unit is its last backup — what the 7-day
// reminder measures from — and the rows together say who took customer data
// out of the system, and when.
export default (sequelize, DataTypes) => {
    const DataExport = sequelize.define(
        "DataExport",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            businessUnitId: { type: DataTypes.INTEGER, allowNull: false },
            userId: { type: DataTypes.INTEGER, allowNull: true },
            // The job, on a one-job export.
            opportunityId: { type: DataTypes.INTEGER, allowNull: true },
            scope: { type: DataTypes.STRING(10), allowNull: false, validate: { isIn: [["job", "unit"]] } },
            // Every job in the unit: no stage, lifecycle or date filter.
            fullBackup: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            jobCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
            filters: { type: DataTypes.JSONB, allowNull: true },
        },
        {
            tableName: "data_exports",
            updatedAt: false, // a record of what happened, never edited
        }
    );

    DataExport.associate = (db) => {
        DataExport.belongsTo(db.BusinessUnit, { foreignKey: "businessUnitId", as: "businessUnit" });
        DataExport.belongsTo(db.User, { foreignKey: "userId", as: "user" });
        DataExport.belongsTo(db.Opportunity, { foreignKey: "opportunityId", as: "opportunity" });
    };

    return DataExport;
};
