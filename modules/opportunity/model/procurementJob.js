// One job's passage through procurement & delivery (stage 6): the bill of
// quantities from the accepted quote and its revisions to the site figures,
// the supplier quotes, the price-variation approvals, the Green Deal job and
// the Operations Coordinator's checklist answers (CL-10 to CL-14). Purchase
// orders are rows of their own (purchase_orders). Shapes are described on the
// migration (20261003000002) and mirrored by prestige-fe helpers/procurement.js.
export default (sequelize, DataTypes) => {
    const ProcurementJob = sequelize.define(
        "ProcurementJob",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            opportunityId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
            boq: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
            revisions: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
            quotes: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
            approvals: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
            greenDeal: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
            checklist: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
            enteredAt: { type: DataTypes.DATE },
        },
        { tableName: "procurement_jobs" }
    );

    ProcurementJob.associate = (db) => {
        ProcurementJob.belongsTo(db.Opportunity, { foreignKey: "opportunityId", as: "opportunity" });
    };

    return ProcurementJob;
};
