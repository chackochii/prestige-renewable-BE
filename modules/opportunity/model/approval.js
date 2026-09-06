// Regulatory / third-party approvals gathered at stage 5. Rows are seeded from
// the unit's approvalTypes config (e.g. council, dnsp, strata, rebate for solar;
// none for communications), so valid types vary per business unit.
export default (sequelize, DataTypes) => {
    const Approval = sequelize.define(
        "Approval",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            opportunityId: { type: DataTypes.INTEGER, allowNull: false },
            // Validated against the unit's approvalTypes keys at the service layer
            type: { type: DataTypes.STRING(20), allowNull: false },
            label: { type: DataTypes.STRING },
            required: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
            status: {
                type: DataTypes.STRING(20),
                allowNull: false,
                defaultValue: "Not Started",
                validate: { isIn: [["Not Started", "Submitted", "Pending", "Approved", "Rejected", "Not Required", "Expired"]] },
            },
            ownerRole: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "BOM" },
            submittedAt: { type: DataTypes.DATE },
            outcomeAt: { type: DataTypes.DATE },
            notes: { type: DataTypes.TEXT },
            documentName: { type: DataTypes.STRING },
        },
        {
            tableName: "approvals",
            indexes: [{ unique: true, fields: ["opportunity_id", "type"] }],
        }
    );

    Approval.associate = (db) => {
        Approval.belongsTo(db.Opportunity, { foreignKey: "opportunityId", as: "opportunity" });
    };

    return Approval;
};
