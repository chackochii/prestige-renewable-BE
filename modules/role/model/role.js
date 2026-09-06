// One row per assignable role. The catalog is seeded (seeders/roles-permissions.cjs)
// but everything about a role is data: grants live in role_permissions, users
// carry role codes validated against this table, and the service supports
// runtime create/rename/retire — so making the catalog user-editable later is
// a routing decision, not a redesign.
export default (sequelize, DataTypes) => {
    const Role = sequelize.define(
        "Role",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            code: { type: DataTypes.STRING(20), allowNull: false, unique: true }, // e.g. "BDM", "SOM"
            name: { type: DataTypes.STRING, allowNull: false },
            description: { type: DataTypes.TEXT }, // full responsibility text from the role model
            // Seeded roles the application/workflow depends on — not deletable.
            isSystem: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            // Inactive roles cannot be assigned and grant nothing to holders.
            isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
            // Single-parent inheritance: this role grants its own permissions
            // plus everything its ancestor chain grants. Lets a future role
            // (e.g. Director – BD/Sales) extend BDM without copying grants.
            inheritsFromRoleId: { type: DataTypes.INTEGER, allowNull: true },
        },
        { tableName: "roles" }
    );

    Role.associate = (db) => {
        Role.belongsToMany(db.Permission, {
            through: db.RolePermission,
            foreignKey: "roleId",
            otherKey: "permissionId",
            as: "permissions",
        });
        Role.belongsTo(db.Role, { foreignKey: "inheritsFromRoleId", as: "inheritsFromRole" });
    };

    return Role;
};
