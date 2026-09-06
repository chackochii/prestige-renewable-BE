// Catalog of grantable actions, e.g. "pricing.edit", "document.delete".
// Route handlers check codes via requirePermission(code); which roles hold a
// code is data (role_permissions), not code.
export default (sequelize, DataTypes) => {
    const Permission = sequelize.define(
        "Permission",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            code: { type: DataTypes.STRING(50), allowNull: false, unique: true }, // e.g. "pricing.edit"
            name: { type: DataTypes.STRING, allowNull: false },
            category: { type: DataTypes.STRING(30) }, // grouping for admin UI, e.g. "Quoting"
            // System permissions back requirePermission() calls in code, so
            // their rows are not deletable; admin-created ones (future phase) are.
            isSystem: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        },
        { tableName: "permissions" }
    );

    Permission.associate = (db) => {
        Permission.belongsToMany(db.Role, {
            through: db.RolePermission,
            foreignKey: "permissionId",
            otherKey: "roleId",
            as: "roles",
        });
    };

    return Permission;
};
