// Regulatory / third-party approvals gathered at stage 5 — one row per
// approval type the job needs. Which types a job needs is decided by sales
// or estimation (opportunities.requiredApprovals, keys from the unit's
// approvalTypes catalogue, so valid types vary per business unit); the rows
// are created when the job enters the stage (see approvalsService).
//
// The three types the Operations Coordinator works through a checklist
// (dnsp — CL-07, da — CL-08, finance — CL-09) keep their answers in
// `checklist`; the status, authority, reference and dates are what the
// checklist settled on. Every other type is recorded directly.
export const APPROVAL_STATUSES = ["not_started", "submitted", "approved", "rejected", "not_applicable"];

export default (sequelize, DataTypes) => {
    const Approval = sequelize.define(
        "Approval",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            opportunityId: { type: DataTypes.INTEGER, allowNull: false },
            // A key from the unit's approvalTypes (validated at the service layer).
            type: { type: DataTypes.STRING(20), allowNull: false },
            label: { type: DataTypes.STRING },
            // False once the type was taken off the job's list after the row existed.
            required: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
            status: {
                type: DataTypes.STRING(20),
                allowNull: false,
                defaultValue: "not_started",
                validate: { isIn: [APPROVAL_STATUSES] },
            },
            ownerRole: { type: DataTypes.STRING(5), allowNull: false, defaultValue: "OPC" },
            authority: { type: DataTypes.STRING }, // who it is with: the council, the DNSP, the lender
            reference: { type: DataTypes.STRING(120) },
            ownerId: { type: DataTypes.INTEGER, allowNull: true }, // who lodged it
            submittedAt: { type: DataTypes.DATE },
            outcomeAt: { type: DataTypes.DATE },
            notes: { type: DataTypes.TEXT },
            documentName: { type: DataTypes.STRING },
            checklist: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        },
        {
            tableName: "approvals",
            indexes: [{ unique: true, fields: ["opportunity_id", "type"] }],
        }
    );

    Approval.associate = (db) => {
        Approval.belongsTo(db.Opportunity, { foreignKey: "opportunityId", as: "opportunity" });
        Approval.belongsTo(db.User, { foreignKey: "ownerId", as: "owner" });
    };

    return Approval;
};
