// The salesperson assignment trail on a lead: every assignment, reassignment
// and unassignment — from whom, to whom, by whom, when and why. Append-only.
export const ASSIGNMENT_KINDS = ["assigned", "reassigned", "unassigned"];

export default (sequelize, DataTypes) => {
    const LeadAssignment = sequelize.define(
        "LeadAssignment",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            opportunityId: { type: DataTypes.INTEGER, allowNull: false },
            fromUserId: { type: DataTypes.INTEGER, allowNull: true },
            toUserId: { type: DataTypes.INTEGER, allowNull: true },
            assignedById: { type: DataTypes.INTEGER, allowNull: true },
            kind: { type: DataTypes.STRING(20), allowNull: false, validate: { isIn: [ASSIGNMENT_KINDS] } },
            reason: { type: DataTypes.STRING(2000) },
        },
        { tableName: "lead_assignments", updatedAt: false }
    );

    LeadAssignment.associate = (db) => {
        LeadAssignment.belongsTo(db.Opportunity, { foreignKey: "opportunityId", as: "opportunity" });
        LeadAssignment.belongsTo(db.User, { foreignKey: "fromUserId", as: "fromUser" });
        LeadAssignment.belongsTo(db.User, { foreignKey: "toUserId", as: "toUser" });
        LeadAssignment.belongsTo(db.User, { foreignKey: "assignedById", as: "assignedBy" });
    };

    return LeadAssignment;
};
