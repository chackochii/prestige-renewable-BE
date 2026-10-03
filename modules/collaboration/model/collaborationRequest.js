// A request or assignment one team raises on another from a pipeline stage.
//
// The two kinds behave differently and the statuses below mirror
// prestige-fe/src/constants/collaboration.js — keep them in step.

export const REQUEST_KINDS = ["information", "assignment"];
export const DEPARTMENTS = ["sales", "operations", "procurement", "finance", "admin"];

/**
 * Who a department's requests go to: the role codes that make a person part
 * of it (seeders/roles-permissions.cjs). A person holding several roles may
 * sit in several departments. The people directory stamps these on every
 * user (GET /users/directory → departments), so a requester's "assign to"
 * list can be narrowed to the team they chose. Estimators (DEST) are the
 * requesters here, not a team requests are sent to, so they sit in none.
 */
export const DEPARTMENT_ROLES = {
    sales: ["SMM", "SREP"],
    operations: ["BOM", "OPC", "SITEOM", "CREW", "QSM", "OMM"],
    procurement: ["PROC"],
    finance: ["FIN"],
    admin: ["BO", "SYS", "HRM", "ADM"],
};

/** The departments a user belongs to, from their role codes. */
export const departmentsForRoles = (roles) => {
    const held = Array.isArray(roles) ? roles : [];
    return DEPARTMENTS.filter((department) => DEPARTMENT_ROLES[department].some((code) => held.includes(code)));
};
/**
 * A request's priority says whether the thing has to happen, not how urgent
 * it is: the team receiving it schedules off necessity. One scale for every
 * kind, so a list of requests sorts and reads as one list.
 */
export const PRIORITIES = ["required", "preferred", "not_required"];
/**
 * The urgency scale information requests carried before Oct 2026. Rows
 * raised then still hold these, so a saved row keeps validating — they are
 * just not accepted on anything new.
 */
export const LEGACY_PRIORITIES = ["low", "medium", "high", "urgent"];

// Kept for callers that ask per kind; both kinds share the one scale now.
export const prioritiesFor = () => PRIORITIES;

/** What a new request starts on when the requester does not say. */
export const defaultPriorityFor = () => "required";

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

/**
 * assignment: requested → assigned → scheduled → in progress → completed →
 * report submitted → accepted. The findings coming in (the report, or the
 * site-visit form) is not the end: the person who asked for the visit reads
 * them and either approves them (`accepted`, closed) or sends them back
 * (`returned`, open again for operations to go once more).
 */
export const ASSIGNMENT_STATUSES = [
    "requested",
    "assigned",
    "scheduled",
    "rescheduled",
    "in_progress",
    "completed",
    "report_submitted",
    "accepted",
    "returned",
    "review_required",
    "cancelled",
];

/** The requester's decisions on an assignment — never set by the assignee. */
export const ASSIGNMENT_DECISIONS = ["accepted", "returned"];

export const statusesFor = (kind) => (kind === "assignment" ? ASSIGNMENT_STATUSES : INFORMATION_STATUSES);

/** An assignment nobody has to act on any more. */
export const CLOSED_ASSIGNMENT_STATUSES = ["accepted", "cancelled"];

/** Statuses that still need somebody to act. */
export const OPEN_STATUSES = [
    ...INFORMATION_STATUSES.filter((s) => !["accepted", "cancelled"].includes(s)),
    ...ASSIGNMENT_STATUSES.filter((s) => !CLOSED_ASSIGNMENT_STATUSES.includes(s)),
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
            stage: { type: DataTypes.INTEGER, validate: { min: 1, max: 11 } }, // stageAccess.LAST_STAGE
            title: { type: DataTypes.STRING(200), allowNull: false, validate: { len: [1, 200] } },
            description: { type: DataTypes.TEXT },
            // Information request: [{ key, label, type }] — the response form is
            // built from this. Pre-site inspection: [{ key, label, kind }] — what
            // the requester wrote in themselves beyond the checklist, which the
            // coordinator carries onto the site member's form.
            requestedFields: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
            // [{ key, label, type, comment }] — the files asked for.
            requestedDocuments: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
            createdById: { type: DataTypes.INTEGER },
            assigneeId: { type: DataTypes.INTEGER },
            // One of PRIORITIES — or, on a row from before the scale changed, LEGACY_PRIORITIES.
            priority: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "required" },
            // Pre-site inspection: the checklist items the requester marked as
            // required, which become the site member's form. Keys from
            // prestige-fe/src/constants/inspectionReport.js.
            inspectionChecklist: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
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
                priorityIsKnown() {
                    if (this.priority && !PRIORITIES.includes(this.priority) && !LEGACY_PRIORITIES.includes(this.priority))
                        throw new Error(`priority must be one of: ${PRIORITIES.join(", ")}`);
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
        CollaborationRequest.hasOne(db.CollaborationSiteVisit, { foreignKey: "requestId", as: "siteVisit" });
    };

    return CollaborationRequest;
};
