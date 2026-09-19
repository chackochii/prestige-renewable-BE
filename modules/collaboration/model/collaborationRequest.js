// A request or assignment one team raises on another from a pipeline stage.
//
// The two kinds behave differently and the statuses below mirror
// prestige-fe/src/constants/collaboration.js — keep them in step.

export const REQUEST_KINDS = ["information", "assignment"];
export const DEPARTMENTS = ["sales", "operations", "procurement", "finance", "admin"];
export const REQUEST_PRIORITIES = ["low", "medium", "high", "urgent"];

/** information: pending → responded → under review → accepted. */
export const INFORMATION_STATUSES = [
    "pending",
    "clarification_required",
    "draft_saved",
    "responded",
    "under_review",
    "accepted",
    "returned",
    "cancelled",
];

/** assignment: requested → assigned → scheduled → in progress → completed → report. */
export const ASSIGNMENT_STATUSES = [
    "requested",
    "assigned",
    "scheduled",
    "rescheduled",
    "in_progress",
    "completed",
    "report_submitted",
    "review_required",
    "cancelled",
];

export const statusesFor = (kind) => (kind === "assignment" ? ASSIGNMENT_STATUSES : INFORMATION_STATUSES);

/** Statuses that still need somebody to act. */
export const OPEN_STATUSES = [
    ...INFORMATION_STATUSES.filter((s) => !["accepted", "cancelled"].includes(s)),
    ...ASSIGNMENT_STATUSES.filter((s) => !["report_submitted", "cancelled"].includes(s)),
];

export default (sequelize, DataTypes) => {
    const CollaborationRequest = sequelize.define(
        "CollaborationRequest",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            businessUnitId: { type: DataTypes.INTEGER, allowNull: false },
            opportunityId: { type: DataTypes.INTEGER, allowNull: false },
            kind: { type: DataTypes.STRING(20), allowNull: false, validate: { isIn: [REQUEST_KINDS] } },
            department: { type: DataTypes.STRING(20), allowNull: false, validate: { isIn: [DEPARTMENTS] } },
            stage: { type: DataTypes.INTEGER, validate: { min: 1, max: 9 } },
            title: { type: DataTypes.STRING(200), allowNull: false, validate: { len: [1, 200] } },
            description: { type: DataTypes.TEXT },
            // [{ key, label, type }] — the response form is built from this.
            requestedFields: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
            // [{ key, label, type, comment }] — the files asked for.
            requestedDocuments: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
            createdById: { type: DataTypes.INTEGER },
            assigneeId: { type: DataTypes.INTEGER },
            priority: {
                type: DataTypes.STRING(10),
                allowNull: false,
                defaultValue: "medium",
                validate: { isIn: [REQUEST_PRIORITIES] },
            },
            dueAt: { type: DataTypes.DATE },
            scheduledFor: { type: DataTypes.DATE },
            status: { type: DataTypes.STRING(30), allowNull: false },
            clarificationNote: { type: DataTypes.TEXT },
            cancelledReason: { type: DataTypes.TEXT },
            responseFields: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
            responseNote: { type: DataTypes.TEXT },
            responseDraft: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            responseSubmittedAt: { type: DataTypes.DATE },
            responseSubmittedById: { type: DataTypes.INTEGER },
        },
        {
            tableName: "collaboration_requests",
            paranoid: true,
            validate: {
                statusBelongsToKind() {
                    if (this.status && !statusesFor(this.kind).includes(this.status))
                        throw new Error(`status "${this.status}" is not valid for a ${this.kind} request`);
                },
            },
            indexes: [
                { fields: ["opportunity_id"] },
                { fields: ["business_unit_id", "status"] },
                { fields: ["assignee_id", "status"] },
                { fields: ["created_by_id", "status"] },
            ],
        }
    );

    CollaborationRequest.associate = (db) => {
        CollaborationRequest.belongsTo(db.BusinessUnit, { foreignKey: "businessUnitId", as: "businessUnit" });
        CollaborationRequest.belongsTo(db.Opportunity, { foreignKey: "opportunityId", as: "opportunity" });
        CollaborationRequest.belongsTo(db.User, { foreignKey: "createdById", as: "createdBy" });
        CollaborationRequest.belongsTo(db.User, { foreignKey: "assigneeId", as: "assignee" });
        CollaborationRequest.belongsTo(db.User, { foreignKey: "responseSubmittedById", as: "responseSubmittedBy" });
        CollaborationRequest.hasMany(db.CollaborationProgress, { foreignKey: "requestId", as: "progress" });
        CollaborationRequest.hasMany(db.CollaborationAttachment, { foreignKey: "requestId", as: "attachments" });
        CollaborationRequest.hasMany(db.CollaborationEvent, { foreignKey: "requestId", as: "events" });
    };

    return CollaborationRequest;
};
