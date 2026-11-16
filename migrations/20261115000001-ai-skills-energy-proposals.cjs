"use strict";

// AI skills and energy proposals (Nov 2026).
//
//   ai_skills          the instructions the AI works to, edited on Admin → AI
//                      skills: the skill's main text (SKILL.md), its reference
//                      files (methodology, examples) and the calculator
//                      settings (products, prices, incentive rules, finance,
//                      savings assumptions). One skill per purpose; the energy
//                      proposal skill is seeded here from the Prestige proposal
//                      skill (modules/aiSkill/defaults/energy-proposal-skill.md).
//   ai_skill_versions  every saved version of a skill, so an edit can be seen
//                      and rolled back.
//   energy_proposals   the commercial Solar + BESS proposal on a job: the
//                      calculator's input (bills, tariff, system, prices), its
//                      result, the words around it, and the skill version it
//                      was made with. The PDF is built from these.
//
// Permission skills.manage (Business Owner, SysAdmin; ADM always) edits skills.

const fs = require("node:fs");
const path = require("node:path");

const PERMISSION = ["skills.manage", "Manage AI skills (proposal calculator and its settings)", "System Administration"];
const GRANT_TO = ["BO", "SYS"];

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        const timestamps = {
            created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
            updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
        };
        const userRef = { type: Sequelize.INTEGER, allowNull: true, references: { model: "users", key: "id" }, onDelete: "SET NULL" };

        await queryInterface.createTable("ai_skills", {
            id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            key: { type: Sequelize.STRING(60), allowNull: false, unique: true },
            name: { type: Sequelize.STRING(120), allowNull: false },
            description: { type: Sequelize.STRING(1000), allowNull: true },
            purpose: { type: Sequelize.STRING(40), allowNull: false, defaultValue: "energy_proposal" },
            content: { type: Sequelize.TEXT, allowNull: false, defaultValue: "" },
            // [{ name, content, size, uploadedAt, uploadedById, uploadedBy }]
            references: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
            settings: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
            is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
            version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
            updated_by_id: userRef,
            ...timestamps,
        });

        await queryInterface.createTable("ai_skill_versions", {
            id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            skill_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: "ai_skills", key: "id" }, onDelete: "CASCADE" },
            version: { type: Sequelize.INTEGER, allowNull: false },
            name: { type: Sequelize.STRING(120), allowNull: false },
            content: { type: Sequelize.TEXT, allowNull: false, defaultValue: "" },
            references: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
            settings: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
            note: { type: Sequelize.STRING(500), allowNull: true },
            edited_by_id: userRef,
            created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
        });
        await queryInterface.addIndex("ai_skill_versions", ["skill_id", "version"], { unique: true, name: "ai_skill_versions_skill_version_uq" });

        await queryInterface.createTable("energy_proposals", {
            id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            opportunity_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: "opportunities", key: "id" }, onDelete: "CASCADE" },
            business_unit_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: "business_units", key: "id" }, onDelete: "CASCADE" },
            number: { type: Sequelize.STRING(40), allowNull: false }, // QN202611060039-S
            revision: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
            title: { type: Sequelize.STRING(200), allowNull: true },
            status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "draft" }, // draft | final
            prepared_on: { type: Sequelize.DATEONLY, allowNull: true },
            valid_until: { type: Sequelize.DATEONLY, allowNull: true },
            skill_id: { type: Sequelize.INTEGER, allowNull: true, references: { model: "ai_skills", key: "id" }, onDelete: "SET NULL" },
            skill_version: { type: Sequelize.INTEGER, allowNull: true },
            input: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
            result: { type: Sequelize.JSONB, allowNull: true },
            narrative: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
            // { model, instructions, documentIds, at, openItems } — what the AI was asked and said
            ai: { type: Sequelize.JSONB, allowNull: true },
            document_id: { type: Sequelize.INTEGER, allowNull: true, references: { model: "documents", key: "id" }, onDelete: "SET NULL" },
            created_by_id: userRef,
            updated_by_id: userRef,
            finalised_at: { type: Sequelize.DATE, allowNull: true },
            finalised_by_id: userRef,
            ...timestamps,
        });
        await queryInterface.addIndex("energy_proposals", ["opportunity_id", "created_at"], { name: "energy_proposals_opportunity" });
        await queryInterface.addIndex("energy_proposals", ["number", "revision"], { name: "energy_proposals_number" });

        const { sequelize } = queryInterface;
        const content = fs.readFileSync(path.join(__dirname, "..", "modules", "aiSkill", "defaults", "energy-proposal-skill.md"), "utf8");
        await sequelize.query(
            `INSERT INTO ai_skills (key, name, description, purpose, content, "references", settings, is_active, version, created_at, updated_at)
             VALUES ('energy-proposal', 'Solar + BESS + EV proposal calculator', :description, 'energy_proposal', :content, '[]', '{}', true, 1, NOW(), NOW())
             ON CONFLICT (key) DO NOTHING`,
            {
                replacements: {
                    description:
                        "Reviews a client's electricity bills, chooses the system size and works out price, incentives, payment options, savings and payback for every commercial proposal.",
                    content,
                },
            }
        );
        await sequelize.query(
            `INSERT INTO ai_skill_versions (skill_id, version, name, content, "references", settings, note, created_at)
             SELECT id, 1, name, content, "references", settings, 'Initial version (Prestige proposal skill, Nov 2026)', NOW() FROM ai_skills WHERE key = 'energy-proposal'
             ON CONFLICT DO NOTHING`
        );

        const [code, name, category] = PERMISSION;
        await sequelize.query(
            `INSERT INTO permissions (code, name, category, is_system, created_at, updated_at)
             VALUES (:code, :name, :category, true, NOW(), NOW())
             ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category, is_system = true, updated_at = NOW()`,
            { replacements: { code, name, category } }
        );
        // On a brand-new database the roles do not exist yet; the seeder grants it then.
        await sequelize.query(
            `INSERT INTO role_permissions (role_id, permission_id, created_at, updated_at)
             SELECT r.id, p.id, NOW(), NOW() FROM roles r, permissions p
             WHERE r.code IN (:roles) AND p.code = :code
             ON CONFLICT (role_id, permission_id) DO NOTHING`,
            { replacements: { code, roles: GRANT_TO } }
        );
    },

    async down(queryInterface) {
        await queryInterface.sequelize.query("DELETE FROM permissions WHERE code = :code", { replacements: { code: PERMISSION[0] } });
        await queryInterface.dropTable("energy_proposals");
        await queryInterface.dropTable("ai_skill_versions");
        await queryInterface.dropTable("ai_skills");
    },
};
