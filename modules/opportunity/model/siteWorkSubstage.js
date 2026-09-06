// Stage 7 site-works substages. Rows are seeded from the unit's
// siteWorkSubstages config (e.g. 7a Pre-work site check … 7e Commissioning
// for solar), so the set of substages varies per business unit.
export default (sequelize, DataTypes) => {
    const SiteWorkSubstage = sequelize.define(
        "SiteWorkSubstage",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            opportunityId: { type: DataTypes.INTEGER, allowNull: false },
            // Validated against the unit's siteWorkSubstages keys at the service layer
            key: { type: DataTypes.STRING(5), allowNull: false },
            label: { type: DataTypes.STRING },
            status: {
                type: DataTypes.STRING(20),
                allowNull: false,
                defaultValue: "not_started",
                validate: { isIn: [["not_started", "in_progress", "signed_off", "failed"]] },
            },
            // e.g. [{ label: "Completed on site", done: false }, ...]
            checklist: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
            sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
            defects: { type: DataTypes.TEXT },
            signedOffAt: { type: DataTypes.DATE },
            signedOffById: { type: DataTypes.INTEGER, allowNull: true },
            assignedToId: { type: DataTypes.INTEGER, allowNull: true },
        },
        {
            tableName: "site_work_substages",
            indexes: [{ unique: true, fields: ["opportunity_id", "key"] }],
        }
    );

    SiteWorkSubstage.associate = (db) => {
        SiteWorkSubstage.belongsTo(db.Opportunity, { foreignKey: "opportunityId", as: "opportunity" });
        SiteWorkSubstage.belongsTo(db.User, { foreignKey: "signedOffById", as: "signedOffBy" });
        SiteWorkSubstage.belongsTo(db.User, { foreignKey: "assignedToId", as: "assignedTo" });
    };

    return SiteWorkSubstage;
};
