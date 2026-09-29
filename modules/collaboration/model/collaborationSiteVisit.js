// The site-visit form a coordinator hands to whoever is attending an
// assignment — a crew member in the directory, or a contractor's electrician
// with no account here.
//
// The token is the public link's whole authority: it opens this one form and
// nothing else, with no sign-in. It stays pending until the person attending
// submits it, whatever the assignment's own status says. Photos they upload
// are CollaborationAttachments on the request (category "site_visit"), so
// the requester can file them on the job like any other supplied file.

export const SITE_VISIT_STATUSES = ["pending", "submitted"];

export default (sequelize, DataTypes) => {
    const CollaborationSiteVisit = sequelize.define(
        "CollaborationSiteVisit",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            requestId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
            token: { type: DataTypes.STRING(64), allowNull: false, unique: true },
            status: {
                type: DataTypes.STRING(20),
                allowNull: false,
                defaultValue: "pending",
                validate: { isIn: [SITE_VISIT_STATUSES] },
            },
            assigneeId: { type: DataTypes.INTEGER },
            assigneeName: { type: DataTypes.STRING(120) },
            assigneeEmail: { type: DataTypes.STRING(254) },
            assigneePhone: { type: DataTypes.STRING(40) },
            // [{ key, label, kind }] — kind picks the control on the public form.
            requestedFields: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
            // [{ key, label, type: image | document, comment }] — one upload slot each.
            requestedDocuments: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
            // { name, email, phone, fields: { key: answer } } once submitted.
            response: { type: DataTypes.JSONB },
            submittedAt: { type: DataTypes.DATE },
            createdById: { type: DataTypes.INTEGER },
        },
        { tableName: "collaboration_site_visits" }
    );

    CollaborationSiteVisit.associate = (db) => {
        CollaborationSiteVisit.belongsTo(db.CollaborationRequest, { foreignKey: "requestId", as: "request" });
        CollaborationSiteVisit.belongsTo(db.User, { foreignKey: "assigneeId", as: "assignee" });
        CollaborationSiteVisit.belongsTo(db.User, { foreignKey: "createdById", as: "createdBy" });
    };

    return CollaborationSiteVisit;
};
