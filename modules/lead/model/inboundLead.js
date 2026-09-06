// Review queue for automated lead capture. Every lead a platform webhook
// delivers lands here exactly as received (payload) plus best-effort
// normalized contact and attribution columns; a reviewer converts it into a
// stage-1 opportunity or rejects it. (source, externalLeadId) is unique, so a
// platform re-sending the same lead is a no-op. A lead matching an earlier
// one's email/phone is kept and flagged via duplicateOfId — still
// convertible; the reviewer decides.
import { LEAD_PLATFORMS } from "./integrationConnection.js";

export const INBOUND_LEAD_STATUSES = ["pending", "converted", "rejected"];

export default (sequelize, DataTypes) => {
    const InboundLead = sequelize.define(
        "InboundLead",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            connectionId: { type: DataTypes.INTEGER, allowNull: true }, // kept if the connection is removed
            businessUnitId: { type: DataTypes.INTEGER, allowNull: false }, // snapshot from the connection at ingest
            source: {
                type: DataTypes.STRING(20),
                allowNull: false,
                validate: { isIn: [LEAD_PLATFORMS] },
            },
            externalLeadId: { type: DataTypes.STRING }, // platform's lead id — idempotency key
            status: {
                type: DataTypes.STRING(20),
                allowNull: false,
                defaultValue: "pending",
                validate: { isIn: [INBOUND_LEAD_STATUSES] },
            },
            payload: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} }, // raw webhook body, never lost

            // Normalized contact (mapped from the platform's form fields)
            name: { type: DataTypes.STRING },
            email: { type: DataTypes.STRING },
            phone: { type: DataTypes.STRING },
            company: { type: DataTypes.STRING },
            suburb: { type: DataTypes.STRING },
            postcode: { type: DataTypes.STRING(10) },
            message: { type: DataTypes.TEXT },

            // Attribution — generic across platforms (Google ad group ≙ Meta
            // adset ≙ LinkedIn creative); raw ids stay in payload.
            campaignId: { type: DataTypes.STRING },
            campaignName: { type: DataTypes.STRING },
            adGroupId: { type: DataTypes.STRING },
            adGroupName: { type: DataTypes.STRING },
            adId: { type: DataTypes.STRING },
            adName: { type: DataTypes.STRING },
            formId: { type: DataTypes.STRING },
            formName: { type: DataTypes.STRING },

            // Same email/phone as an earlier lead — kept, flagged, reviewable.
            duplicateOfId: { type: DataTypes.INTEGER, allowNull: true },

            // Review outcome
            opportunityId: { type: DataTypes.INTEGER, allowNull: true }, // set on convert
            reviewedById: { type: DataTypes.INTEGER, allowNull: true },
            reviewedAt: { type: DataTypes.DATE },
            rejectReason: { type: DataTypes.TEXT },

            receivedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        },
        {
            tableName: "inbound_leads",
            indexes: [
                { fields: ["status"] },
                { fields: ["business_unit_id"] },
                { fields: ["email"] },
                { fields: ["phone"] },
                { fields: ["opportunity_id"] },
            ],
        }
    );

    InboundLead.associate = (db) => {
        InboundLead.belongsTo(db.IntegrationConnection, { foreignKey: "connectionId", as: "connection" });
        InboundLead.belongsTo(db.BusinessUnit, { foreignKey: "businessUnitId", as: "businessUnit" });
        InboundLead.belongsTo(db.Opportunity, { foreignKey: "opportunityId", as: "opportunity" });
        InboundLead.belongsTo(db.User, { foreignKey: "reviewedById", as: "reviewedBy" });
        InboundLead.belongsTo(db.InboundLead, { foreignKey: "duplicateOfId", as: "duplicateOf" });
    };

    return InboundLead;
};
