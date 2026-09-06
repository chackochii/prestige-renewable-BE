// Staff and external contributors (referrer portal logins) share this table.
// Users carry role codes (e.g. "BDM", "SOM") resolved against the roles table
// — the assignable set is data, not code, so roles added at runtime need no
// model change. See seeders/roles-permissions.cjs for the seeded catalog.
import bcrypt from "bcryptjs";

// Hashing lives on the model so no caller can accidentally store plain text.
const hashPassword = async (user) => {
    if (user.changed("password")) user.password = await bcrypt.hash(user.password, 10);
};

export default (sequelize, DataTypes) => {
    const User = sequelize.define(
        "User",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            name: { type: DataTypes.STRING, allowNull: false },
            // Uniqueness is enforced by a partial index (users_email_active_uq)
            // covering non-deleted rows only, so soft-deleted emails can be reused
            email: { type: DataTypes.STRING, allowNull: false, validate: { isEmail: true } },
            // Plain text on the way in; the beforeCreate/beforeUpdate hooks hash
            // it. Length is validated pre-hash (a bcrypt hash is 60 chars).
            password: { type: DataTypes.STRING, allowNull: false, validate: { len: [8, 100] } },
            roles: {
                type: DataTypes.ARRAY(DataTypes.STRING(20)),
                allowNull: false,
                defaultValue: [],
                validate: {
                    async rolesAssignable(value) {
                        if (!Array.isArray(value) || value.some((code) => typeof code !== "string")) {
                            throw new Error("roles must be an array of role code strings");
                        }
                        const codes = [...new Set(value)];
                        if (!codes.length) return;
                        const found = await sequelize.models.Role.findAll({
                            where: { code: codes, isActive: true },
                            attributes: ["code"],
                        });
                        if (found.length !== codes.length) {
                            const known = new Set(found.map((r) => r.code));
                            const bad = codes.filter((c) => !known.has(c));
                            throw new Error(`Unknown or inactive roles: ${bad.join(", ")}`);
                        }
                    },
                },
            },
            title: { type: DataTypes.STRING }, // job title, e.g. "Site Supervisor"
            phone: { type: DataTypes.STRING(30) },
            status: {
                type: DataTypes.STRING(20),
                allowNull: false,
                defaultValue: "active",
                validate: { isIn: [["active", "disabled"]] },
            },
            // Set only for REF users — links a portal login to its referrer organisation
            referrerId: { type: DataTypes.INTEGER, allowNull: true },
            lastLoginAt: { type: DataTypes.DATE }, // stamped by the auth layer on login
        },
        {
            tableName: "users",
            paranoid: true, // soft delete — destroy() sets deleted_at, queries exclude deleted rows
            defaultScope: { attributes: { exclude: ["password"] } },
            scopes: { withPassword: {} },
            hooks: { beforeCreate: hashPassword, beforeUpdate: hashPassword },
        }
    );

    // For the auth layer — fetch via scope("withPassword") first.
    User.prototype.checkPassword = function (plain) {
        return bcrypt.compare(plain, this.password);
    };

    User.associate = (db) => {
        User.belongsToMany(db.BusinessUnit, {
            through: db.UserBusinessUnit,
            foreignKey: "userId",
            otherKey: "businessUnitId",
            as: "businessUnits",
        });
        User.belongsTo(db.Referrer, { foreignKey: "referrerId", as: "referrer" });
        User.hasMany(db.Notification, { foreignKey: "userId", as: "notifications" });
    };

    return User;
};
