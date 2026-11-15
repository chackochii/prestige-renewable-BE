// One row per change anyone makes: who, when, from where (source), to what.
// Append-only — there is no update or delete. Recorded by
// activityService.recordActivity from every module that changes data.
export const ACTIVITY_SOURCES = ["web", "api", "public", "webhook", "system", "seed"];

export default (sequelize, DataTypes) => {
    const ActivityLog = sequelize.define(
        "ActivityLog",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            businessUnitId: { type: DataTypes.INTEGER, allowNull: true },
            actorId: { type: DataTypes.INTEGER, allowNull: true },
            actorName: { type: DataTypes.STRING(255), allowNull: true },
            source: { type: DataTypes.STRING(30), allowNull: false, defaultValue: "web" },
            entityType: { type: DataTypes.STRING(40), allowNull: false },
            entityId: { type: DataTypes.STRING(40), allowNull: true },
            entityLabel: { type: DataTypes.STRING(255), allowNull: true },
            action: { type: DataTypes.STRING(60), allowNull: false },
            changes: { type: DataTypes.JSONB, allowNull: true }, // { field: { from, to } }
            meta: { type: DataTypes.JSONB, allowNull: true },
            ip: { type: DataTypes.STRING(45), allowNull: true },
            userAgent: { type: DataTypes.STRING(300), allowNull: true },
        },
        {
            tableName: "activity_logs",
            updatedAt: false,
            indexes: [
                { fields: ["business_unit_id", "created_at"] },
                { fields: ["entity_type", "entity_id"] },
                { fields: ["actor_id"] },
            ],
        }
    );

    ActivityLog.associate = (db) => {
        ActivityLog.belongsTo(db.User, { foreignKey: "actorId", as: "actor" });
        ActivityLog.belongsTo(db.BusinessUnit, { foreignKey: "businessUnitId", as: "businessUnit" });
    };

    return ActivityLog;
};
