// One saved version of an AI skill — what it held after that save.
export default (sequelize, DataTypes) => {
    const AiSkillVersion = sequelize.define(
        "AiSkillVersion",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            skillId: { type: DataTypes.INTEGER, allowNull: false },
            version: { type: DataTypes.INTEGER, allowNull: false },
            name: { type: DataTypes.STRING(120), allowNull: false },
            content: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
            references: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
            settings: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
            note: { type: DataTypes.STRING(500) },
            editedById: { type: DataTypes.INTEGER, allowNull: true },
        },
        { tableName: "ai_skill_versions", updatedAt: false }
    );

    AiSkillVersion.associate = (db) => {
        AiSkillVersion.belongsTo(db.AiSkill, { foreignKey: "skillId", as: "skill" });
        AiSkillVersion.belongsTo(db.User, { foreignKey: "editedById", as: "editedBy" });
    };

    return AiSkillVersion;
};
