// Immutable trail of who did what on an opportunity
export default (sequelize, DataTypes) => {
    const AuditLog = sequelize.define(
        "AuditLog",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            opportunityId: { type: DataTypes.INTEGER, allowNull: false },
            actorId: { type: DataTypes.INTEGER, allowNull: true },
            action: { type: DataTypes.STRING, allowNull: false }, // e.g. "Created lead", "Advanced stage"
            detail: { type: DataTypes.TEXT },
        },
        {
            tableName: "audit_logs",
            updatedAt: false, // audit entries are never edited
            indexes: [{ fields: ["opportunity_id"] }, { fields: ["actor_id"] }],
        }
    );

    AuditLog.associate = (db) => {
        AuditLog.belongsTo(db.Opportunity, { foreignKey: "opportunityId", as: "opportunity" });
        AuditLog.belongsTo(db.User, { foreignKey: "actorId", as: "actor" });
    };

    return AuditLog;
};
