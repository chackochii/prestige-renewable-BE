// Audit trail for a request: who did what, when. Append-only — the API has no
// update or delete for these.
export default (sequelize, DataTypes) => {
    const CollaborationEvent = sequelize.define(
        "CollaborationEvent",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            requestId: { type: DataTypes.INTEGER, allowNull: false },
            action: { type: DataTypes.STRING(60), allowNull: false }, // "Response submitted"
            detail: { type: DataTypes.TEXT },
            actorId: { type: DataTypes.INTEGER },
        },
        {
            tableName: "collaboration_events",
            indexes: [{ fields: ["request_id", "created_at"] }],
        }
    );

    CollaborationEvent.associate = (db) => {
        CollaborationEvent.belongsTo(db.CollaborationRequest, { foreignKey: "requestId", as: "request" });
        CollaborationEvent.belongsTo(db.User, { foreignKey: "actorId", as: "actor" });
    };

    return CollaborationEvent;
};
