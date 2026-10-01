export const PROPOSAL_STATUSES = ["draft", "pending_director", "issued", "presented", "negotiation", "accepted", "rejected", "re-estimated", "withdrawn"];
/** Still waiting on the customer: the link works and can be answered. */
export const OPEN_STATUSES = ["issued", "presented"];
/** Can still change: waiting on the customer, or back with sales to revise. */
export const LIVE_STATUSES = [...OPEN_STATUSES, "negotiation"];
export const PROPOSAL_RESPONSES = ["accepted", "rejected", "renegotiate"];

export default (sequelize, DataTypes) => {
    const Proposal = sequelize.define(
        "Proposal",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            opportunityId: { type: DataTypes.INTEGER, allowNull: false },
            number: { type: DataTypes.STRING(30) }, // e.g. PRS-P-0008-v2
            version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
            estimateVersion: { type: DataTypes.INTEGER }, // estimate version this proposal was built from
            status: {
                type: DataTypes.STRING(20),
                allowNull: false,
                defaultValue: "draft",
                // issued = emailed to the customer, presented = opened by them,
                // negotiation = they asked for changes, re-estimated = sales
                // sent the job back to estimation for a re-quote (see
                // requoteService), withdrawn = replaced by a newer proposal
                // before they answered.
                validate: { isIn: [PROPOSAL_STATUSES] },
            },
            priceEx: { type: DataTypes.DECIMAL(14, 2) },
            margin: { type: DataTypes.DECIMAL(5, 2) },
            issuedAt: { type: DataTypes.DATE },
            presentedAt: { type: DataTypes.DATE },
            acceptedAt: { type: DataTypes.DATE },
            // Director sign-off for below-floor pricing
            directorApprovalStatus: {
                type: DataTypes.STRING(20),
                allowNull: true,
                validate: { isIn: [["pending", "approved", "rejected"]] },
            },
            directorApprovalById: { type: DataTypes.INTEGER, allowNull: true },
            directorApprovalAt: { type: DataTypes.DATE },
            directorApprovalNote: { type: DataTypes.TEXT },
            signedDocName: { type: DataTypes.STRING },
            rejectionReason: { type: DataTypes.TEXT },

            // ---- Sent to the customer (see proposalService) ----
            quoteVersionId: { type: DataTypes.INTEGER, allowNull: true }, // the saved quote the PDF is built from
            grandTotal: { type: DataTypes.DECIMAL(14, 2) },
            tokenHash: { type: DataTypes.STRING(64) }, // SHA-256 of the link token; the token itself is never stored
            expiresAt: { type: DataTypes.DATE },
            sentTo: { type: DataTypes.STRING },
            sentById: { type: DataTypes.INTEGER, allowNull: true },
            emailSubject: { type: DataTypes.STRING(200) },
            emailMessage: { type: DataTypes.TEXT },
            viewedAt: { type: DataTypes.DATE },
            viewCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

            // ---- The customer's answer ----
            response: { type: DataTypes.STRING(20), validate: { isIn: [PROPOSAL_RESPONSES] } },
            respondedAt: { type: DataTypes.DATE },
            responseName: { type: DataTypes.STRING(120) },
            responseNote: { type: DataTypes.TEXT },
            responseIp: { type: DataTypes.STRING(64) },
            responseChannel: { type: DataTypes.STRING(20), validate: { isIn: [["customer", "staff"]] } },
            recordedById: { type: DataTypes.INTEGER, allowNull: true },
        },
        {
            tableName: "proposals",
            indexes: [{ unique: true, fields: ["opportunity_id", "version"] }],
        }
    );

    Proposal.associate = (db) => {
        Proposal.belongsTo(db.Opportunity, { foreignKey: "opportunityId", as: "opportunity" });
        Proposal.belongsTo(db.User, { foreignKey: "directorApprovalById", as: "directorApprovalBy" });
        Proposal.belongsTo(db.QuoteVersion, { foreignKey: "quoteVersionId", as: "quoteVersion" });
        Proposal.belongsTo(db.User, { foreignKey: "sentById", as: "sentBy" });
        Proposal.belongsTo(db.User, { foreignKey: "recordedById", as: "recordedBy" });
    };

    return Proposal;
};
