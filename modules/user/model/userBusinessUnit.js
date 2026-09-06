// Join table: which business units each user can work in. Access is
// deny-by-default — a user only sees units listed here (ADM sees all).
export default (sequelize, DataTypes) => {
    const UserBusinessUnit = sequelize.define(
        "UserBusinessUnit",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            userId: { type: DataTypes.INTEGER, allowNull: false },
            businessUnitId: { type: DataTypes.INTEGER, allowNull: false },
            // Administrator who granted the access, set at user creation/assignment
            assignedById: { type: DataTypes.INTEGER, allowNull: true },
        },
        {
            tableName: "user_business_units",
            indexes: [{ unique: true, fields: ["user_id", "business_unit_id"] }],
        }
    );

    UserBusinessUnit.associate = (db) => {
        UserBusinessUnit.belongsTo(db.User, { foreignKey: "assignedById", as: "assignedBy" });
    };

    return UserBusinessUnit;
};
