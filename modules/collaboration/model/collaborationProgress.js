// An assignee moving an assignment along: a status change with a note.
// `internal` entries stay inside the assignee's department — the service
// filters them out for anybody else.
export default (sequelize, DataTypes) => {
    const CollaborationProgress = sequelize.define(
        "CollaborationProgress",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            requestId: { type: DataTypes.INTEGER, allowNull: false },
            status: { type: DataTypes.STRING(30), allowNull: false },
            note: { type: DataTypes.TEXT },
            internal: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            authorId: { type: DataTypes.INTEGER },
        },
        {
            tableName: "collaboration_progress",
            indexes: [{ fields: ["request_id", "created_at"] }],
        }
    );

    CollaborationProgress.associate = (db) => {
        CollaborationProgress.belongsTo(db.CollaborationRequest, { foreignKey: "requestId", as: "request" });
        CollaborationProgress.belongsTo(db.User, { foreignKey: "authorId", as: "author" });
    };

    return CollaborationProgress;
};
