export default (sequelize, DataTypes) => {
    const Notification = sequelize.define(
        "Notification",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            userId: { type: DataTypes.INTEGER, allowNull: false },
            opportunityId: { type: DataTypes.INTEGER, allowNull: true },
            title: { type: DataTypes.STRING, allowNull: false }, // e.g. "SLA overdue"
            body: { type: DataTypes.TEXT },
            read: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        },
        {
            tableName: "notifications",
            indexes: [{ fields: ["user_id", "read"] }],
        }
    );

    Notification.associate = (db) => {
        Notification.belongsTo(db.User, { foreignKey: "userId", as: "user" });
        Notification.belongsTo(db.Opportunity, { foreignKey: "opportunityId", as: "opportunity" });
    };

    return Notification;
};
