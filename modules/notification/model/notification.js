export default (sequelize, DataTypes) => {
    const Notification = sequelize.define(
        "Notification",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            userId: { type: DataTypes.INTEGER, allowNull: false },
            opportunityId: { type: DataTypes.INTEGER, allowNull: true },
            // What happened — a key from notification/service/notificationEvents.js.
            event: { type: DataTypes.STRING(40), allowNull: false, defaultValue: "general" },
            // high | medium | low, resolved when the row is written (the event
            // default, or the business unit's override).
            priority: {
                type: DataTypes.STRING(10),
                allowNull: false,
                defaultValue: "medium",
                validate: { isIn: [["high", "medium", "low"]] },
            },
            title: { type: DataTypes.STRING, allowNull: false }, // e.g. "SLA overdue"
            body: { type: DataTypes.TEXT },
            read: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            // Set by repeatable checks (the SLA watcher) so a notice is raised
            // once per user and event, not on every pass. Unique with user_id.
            dedupeKey: { type: DataTypes.STRING(120), allowNull: true },
        },
        {
            tableName: "notifications",
            indexes: [{ fields: ["user_id", "read"] }, { fields: ["user_id", "created_at"] }],
        }
    );

    Notification.associate = (db) => {
        Notification.belongsTo(db.User, { foreignKey: "userId", as: "user" });
        Notification.belongsTo(db.Opportunity, { foreignKey: "opportunityId", as: "opportunity" });
    };

    return Notification;
};
