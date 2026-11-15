// A job on the calendar. The kind of work decides which team it goes to
// (JOB_TYPE_TEAM); the team's people are told when it is scheduled, and the
// assignee — when one is named — must be on that team.
export const JOB_TYPES = ["installation", "electrical", "commissioning", "site_inspection", "delivery", "maintenance", "service_call", "warranty", "other"];
export const JOB_STATUSES = ["scheduled", "in_progress", "completed", "cancelled"];
export const TEAMS = ["crew", "operations", "procurement", "om", "sales"];

/** Which team does which kind of work. */
export const JOB_TYPE_TEAM = {
    installation: "crew",
    electrical: "crew",
    commissioning: "crew",
    site_inspection: "operations",
    delivery: "procurement",
    maintenance: "om",
    service_call: "om",
    warranty: "om",
    other: "operations",
};

/** The roles that make a person part of a team (seeders/roles-permissions.cjs). */
export const TEAM_ROLES = {
    crew: ["SITEOM", "CREW"],
    operations: ["BOM", "OPC"],
    procurement: ["PROC"],
    om: ["OMM", "QSM"],
    sales: ["SMM", "SSREP", "SREP"],
};

export const TEAM_LABELS = { crew: "Installation crew", operations: "Operations", procurement: "Procurement", om: "O&M", sales: "Sales" };

export const teamForJobType = (jobType) => JOB_TYPE_TEAM[jobType] ?? "operations";

export default (sequelize, DataTypes) => {
    const JobSchedule = sequelize.define(
        "JobSchedule",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            businessUnitId: { type: DataTypes.INTEGER, allowNull: false },
            opportunityId: { type: DataTypes.INTEGER, allowNull: true },
            projectId: { type: DataTypes.INTEGER, allowNull: true },
            title: { type: DataTypes.STRING(200), allowNull: false },
            jobType: { type: DataTypes.STRING(30), allowNull: false, validate: { isIn: [JOB_TYPES] } },
            team: { type: DataTypes.STRING(20), allowNull: false, validate: { isIn: [TEAMS] } },
            assigneeId: { type: DataTypes.INTEGER, allowNull: true },
            scheduledStart: { type: DataTypes.DATE, allowNull: false },
            scheduledEnd: { type: DataTypes.DATE },
            status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "scheduled", validate: { isIn: [JOB_STATUSES] } },
            location: { type: DataTypes.STRING(500) },
            notes: { type: DataTypes.TEXT },
            completedAt: { type: DataTypes.DATE },
            createdById: { type: DataTypes.INTEGER, allowNull: true },
        },
        { tableName: "job_schedules" }
    );

    JobSchedule.associate = (db) => {
        JobSchedule.belongsTo(db.BusinessUnit, { foreignKey: "businessUnitId", as: "businessUnit" });
        JobSchedule.belongsTo(db.Opportunity, { foreignKey: "opportunityId", as: "opportunity" });
        JobSchedule.belongsTo(db.Project, { foreignKey: "projectId", as: "project" });
        JobSchedule.belongsTo(db.User, { foreignKey: "assigneeId", as: "assignee" });
        JobSchedule.belongsTo(db.User, { foreignKey: "createdById", as: "createdBy" });
    };

    return JobSchedule;
};
