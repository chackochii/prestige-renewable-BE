// An AI skill: the instructions the AI works to for one purpose (the energy
// proposal), edited by admins on Admin → AI skills. `content` is the skill's
// main text (SKILL.md), `references` its extra files ([{ name, content, … }]),
// `settings` the calculator's figures, merged over the code's defaults
// (aiSkillService.effectiveSettings). Every save bumps `version` and keeps the
// previous state in ai_skill_versions.
export const SKILL_PURPOSES = ["energy_proposal"];

export default (sequelize, DataTypes) => {
    const AiSkill = sequelize.define(
        "AiSkill",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            key: { type: DataTypes.STRING(60), allowNull: false, unique: true },
            name: { type: DataTypes.STRING(120), allowNull: false },
            description: { type: DataTypes.STRING(1000) },
            purpose: { type: DataTypes.STRING(40), allowNull: false, defaultValue: "energy_proposal", validate: { isIn: [SKILL_PURPOSES] } },
            content: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
            references: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
            settings: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
            isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
            version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
            updatedById: { type: DataTypes.INTEGER, allowNull: true },
        },
        { tableName: "ai_skills" }
    );

    AiSkill.associate = (db) => {
        AiSkill.belongsTo(db.User, { foreignKey: "updatedById", as: "updatedBy" });
        AiSkill.hasMany(db.AiSkillVersion, { foreignKey: "skillId", as: "versions" });
    };

    return AiSkill;
};
