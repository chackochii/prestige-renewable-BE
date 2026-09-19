// A file supplied against a request. "attachment" answers one of the
// documents the requester asked for (documentKey says which); "report" is the
// write-up the requester waits on at the end of an assignment.
//
// The file itself lives in the Space (utils/storage.js); storageKey is its
// object key and never leaves the server.
export const ATTACHMENT_CATEGORIES = ["attachment", "report"];

export default (sequelize, DataTypes) => {
    const CollaborationAttachment = sequelize.define(
        "CollaborationAttachment",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            requestId: { type: DataTypes.INTEGER, allowNull: false },
            category: {
                type: DataTypes.STRING(20),
                allowNull: false,
                defaultValue: "attachment",
                validate: { isIn: [ATTACHMENT_CATEGORIES] },
            },
            documentKey: { type: DataTypes.STRING(60) },
            filename: { type: DataTypes.STRING, allowNull: false },
            mime: { type: DataTypes.STRING(100) },
            size: { type: DataTypes.INTEGER },
            storageKey: { type: DataTypes.STRING(1000), allowNull: false },
            uploaderId: { type: DataTypes.INTEGER },
        },
        {
            tableName: "collaboration_attachments",
            indexes: [{ fields: ["request_id"] }],
        }
    );

    CollaborationAttachment.associate = (db) => {
        CollaborationAttachment.belongsTo(db.CollaborationRequest, { foreignKey: "requestId", as: "request" });
        CollaborationAttachment.belongsTo(db.User, { foreignKey: "uploaderId", as: "uploader" });
    };

    return CollaborationAttachment;
};
