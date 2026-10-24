export default (sequelize, DataTypes) => {
    const Document = sequelize.define(
        "Document",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            opportunityId: { type: DataTypes.INTEGER, allowNull: false },
            type: {
                type: DataTypes.STRING(30),
                allowNull: false,
                defaultValue: "other",
                validate: {
                    isIn: [[
                        "proposal", "energy_bill", "contract", "approval", "evidence", "site_photo", "drawing",
                        "supplier_quote", "acceptance", "certificate", "insurance", "handover", "service", "lead", "other",
                    ]],
                },
            },
            name: { type: DataTypes.STRING, allowNull: false },
            version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
            uploaderId: { type: DataTypes.INTEGER, allowNull: true },
            size: { type: DataTypes.STRING }, // display size or "generated"/"uploaded"
            url: { type: DataTypes.STRING(1000) }, // the file's key in the Space (utils/storage.js), or a link kept elsewhere
            // The file's public address in the Space — what the screens open (storage.publicUrl).
            storageUrl: { type: DataTypes.STRING(1000) },
            // The attachment category it was uploaded under (leadAttachmentService.ATTACHMENT_CATEGORIES);
            // null for a document uploaded by type alone.
            category: { type: DataTypes.STRING(30) },
            label: { type: DataTypes.STRING(50) }, // what it is attached to, e.g. "approval_12", "7c"
            stage: { type: DataTypes.INTEGER }, // pipeline stage it was captured in
            mime: { type: DataTypes.STRING(100) },
            // Copy-to-document-management status
            mirrorStatus: {
                type: DataTypes.STRING(20),
                allowNull: false,
                defaultValue: "pending",
                validate: { isIn: [["pending", "mirrored", "failed"]] },
            },
        },
        {
            tableName: "documents",
            indexes: [{ fields: ["opportunity_id"] }],
        }
    );

    Document.associate = (db) => {
        Document.belongsTo(db.Opportunity, { foreignKey: "opportunityId", as: "opportunity" });
        Document.belongsTo(db.User, { foreignKey: "uploaderId", as: "uploader" });
    };

    return Document;
};
