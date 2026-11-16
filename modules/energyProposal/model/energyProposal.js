// A commercial Solar + BESS (+ EV) proposal on a job. `input` is what the
// calculator works from (client, site, bill periods, tariff, system, prices,
// params); `result` what it worked out (proposalCalculator.calculateProposal);
// `narrative` the words the PDF prints around the numbers. The PDF is built
// from these three in the browser. A final proposal is locked: changing it
// means a new revision.
export const PROPOSAL_STATUSES = ["draft", "final"];

export default (sequelize, DataTypes) => {
    const EnergyProposal = sequelize.define(
        "EnergyProposal",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            opportunityId: { type: DataTypes.INTEGER, allowNull: false },
            businessUnitId: { type: DataTypes.INTEGER, allowNull: false },
            number: { type: DataTypes.STRING(40), allowNull: false },
            revision: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
            title: { type: DataTypes.STRING(200) },
            status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "draft", validate: { isIn: [PROPOSAL_STATUSES] } },
            preparedOn: { type: DataTypes.DATEONLY },
            validUntil: { type: DataTypes.DATEONLY },
            skillId: { type: DataTypes.INTEGER, allowNull: true },
            skillVersion: { type: DataTypes.INTEGER, allowNull: true },
            input: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
            result: { type: DataTypes.JSONB, allowNull: true },
            narrative: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
            ai: { type: DataTypes.JSONB, allowNull: true },
            documentId: { type: DataTypes.INTEGER, allowNull: true },
            createdById: { type: DataTypes.INTEGER, allowNull: true },
            updatedById: { type: DataTypes.INTEGER, allowNull: true },
            finalisedAt: { type: DataTypes.DATE },
            finalisedById: { type: DataTypes.INTEGER, allowNull: true },
            // The quote version a final proposal was saved as — what sales sends
            // the customer (the proposal stage) and the customer accepts.
            quoteVersionId: { type: DataTypes.INTEGER, allowNull: true },
        },
        { tableName: "energy_proposals" }
    );

    EnergyProposal.associate = (db) => {
        EnergyProposal.belongsTo(db.QuoteVersion, { foreignKey: "quoteVersionId", as: "quoteVersion", constraints: false });
        EnergyProposal.belongsTo(db.Opportunity, { foreignKey: "opportunityId", as: "opportunity" });
        EnergyProposal.belongsTo(db.BusinessUnit, { foreignKey: "businessUnitId", as: "businessUnit" });
        EnergyProposal.belongsTo(db.AiSkill, { foreignKey: "skillId", as: "skill" });
        EnergyProposal.belongsTo(db.Document, { foreignKey: "documentId", as: "document" });
        EnergyProposal.belongsTo(db.User, { foreignKey: "createdById", as: "createdBy" });
        EnergyProposal.belongsTo(db.User, { foreignKey: "updatedById", as: "updatedBy" });
        EnergyProposal.belongsTo(db.User, { foreignKey: "finalisedById", as: "finalisedBy" });
    };

    return EnergyProposal;
};
