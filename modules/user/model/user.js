// Staff and external contributors (referrer portal logins) share this table.
// Users carry role codes (e.g. "BDM", "SOM") resolved against the roles table
// — the assignable set is data, not code, so roles added at runtime need no
// model change. See seeders/roles-permissions.cjs for the seeded catalog.
import bcrypt from "bcryptjs";

// Hashing lives on the model so no caller can accidentally store plain text.
// The PIN arrives already hashed (userService hashes it with hashPin) because
// the plain temporary PIN has to be handed back to the administrator once.
const hashPassword = async (user) => {
    if (user.changed("password") && user.password) user.password = await bcrypt.hash(user.password, 10);
};

export const hashPin = (pin) => bcrypt.hash(String(pin), 10);

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
            // Null for a user who signs in with a PIN only (migration 20261114000001).
            password: { type: DataTypes.STRING, allowNull: true, validate: { len: [8, 100] } },
            // A password an administrator set (adding the user, or a reset) is
            // temporary: the person must replace it with their own the first
            // time they sign in with it (migration 20261117000001), when
            // passwordSetAt is stamped.
            passwordIsTemporary: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            passwordSetAt: { type: DataTypes.DATE, allowNull: true },
            // The PIN (hashed) beside the password. An administrator issues a
            // temporary one; the person must replace it with their own on first
            // login (pinIsTemporary), when pinSetAt is stamped.
            pinHash: { type: DataTypes.STRING(60), allowNull: true },
            pinIsTemporary: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            pinSetAt: { type: DataTypes.DATE, allowNull: true },
            pinIssuedById: { type: DataTypes.INTEGER, allowNull: true },
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
            defaultScope: { attributes: { exclude: ["password", "pinHash"] } },
            scopes: { withPassword: {} }, // every column, the hashes included — the auth layer only
            hooks: { beforeCreate: hashPassword, beforeUpdate: hashPassword },
        }
    );

    // For the auth layer — fetch via scope("withPassword") first.
    User.prototype.checkPassword = function (plain) {
        if (!this.password) return Promise.resolve(false);
        return bcrypt.compare(plain, this.password);
    };
    User.prototype.checkPin = function (plain) {
        if (!this.pinHash) return Promise.resolve(false);
        return bcrypt.compare(String(plain), this.pinHash);
    };

    User.associate = (db) => {
        User.belongsToMany(db.BusinessUnit, {
            through: db.UserBusinessUnit,
            foreignKey: "userId",
            otherKey: "businessUnitId",
            as: "businessUnits",
        });
        User.belongsTo(db.Referrer, { foreignKey: "referrerId", as: "referrer" });
        User.belongsTo(db.User, { foreignKey: "pinIssuedById", as: "pinIssuedBy" });
        User.hasMany(db.Notification, { foreignKey: "userId", as: "notifications" });
    };

    return User;
};
