// A signed job: created when the customer accepts the proposal (or by hand),
// it carries what the operations team tracks about the project as a whole —
// how it is paid for, where approvals, procurement and installation stand,
// and who the representative is. The pipeline stage stays on the opportunity;
// this is the operations view of the same job.
export const PROJECT_STATUSES = ["signed", "approvals", "procurement", "scheduled", "installing", "installed", "invoiced", "completed", "on_hold", "cancelled"];
export const PAYMENT_TYPES = ["cash", "loan"];
export const INSTALLATION_STATUSES = ["not_started", "scheduled", "in_progress", "completed"];
export const PROCUREMENT_STATUSES = ["not_started", "in_progress", "ordered", "delivered", "complete"];

export default (sequelize, DataTypes) => {
    const Project = sequelize.define(
        "Project",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            opportunityId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
            businessUnitId: { type: DataTypes.INTEGER, allowNull: false },
            code: { type: DataTypes.STRING(30), allowNull: false },
            paymentType: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "cash", validate: { isIn: [PAYMENT_TYPES] } },
            loanRequestId: { type: DataTypes.INTEGER, allowNull: true },
            status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "signed", validate: { isIn: [PROJECT_STATUSES] } },
            installationStatus: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "not_started", validate: { isIn: [INSTALLATION_STATUSES] } },
            installationProgressPct: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, validate: { min: 0, max: 100 } },
            procurementStatus: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "not_started", validate: { isIn: [PROCUREMENT_STATUSES] } },
            assignedRepId: { type: DataTypes.INTEGER, allowNull: true },
            operationsOwnerId: { type: DataTypes.INTEGER, allowNull: true },
            signedAt: { type: DataTypes.DATE },
            expectedInstallDate: { type: DataTypes.DATEONLY },
            notes: { type: DataTypes.TEXT },
            createdById: { type: DataTypes.INTEGER, allowNull: true },
        },
        { tableName: "projects" }
    );

    Project.associate = (db) => {
        Project.belongsTo(db.Opportunity, { foreignKey: "opportunityId", as: "opportunity" });
        Project.belongsTo(db.BusinessUnit, { foreignKey: "businessUnitId", as: "businessUnit" });
        Project.belongsTo(db.LoanRequest, { foreignKey: "loanRequestId", as: "loanRequest" });
        Project.belongsTo(db.User, { foreignKey: "assignedRepId", as: "assignedRep" });
        Project.belongsTo(db.User, { foreignKey: "operationsOwnerId", as: "operationsOwner" });
        Project.hasMany(db.JobSchedule, { foreignKey: "projectId", as: "jobs" });
        Project.hasMany(db.Installation, { foreignKey: "projectId", as: "installations" });
        Project.hasMany(db.CustomerPayment, { foreignKey: "projectId", as: "payments" });
    };

    return Project;
};
