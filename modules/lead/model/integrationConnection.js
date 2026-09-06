// A connected lead source: one ad account (Google/Meta/LinkedIn) or
// ServiceM8 account, owned by ONE business unit — leads arriving through the
// connection inherit that unit. Connecting a new account is a row, not code:
// the webhook layer looks the connection up by platform + external account id
// (or webhook secret) and files leads under it.
export const LEAD_PLATFORMS = ["google_ads", "meta_ads", "linkedin_ads", "servicem8"];

export default (sequelize, DataTypes) => {
    const IntegrationConnection = sequelize.define(
        "IntegrationConnection",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            businessUnitId: { type: DataTypes.INTEGER, allowNull: false },
            platform: {
                type: DataTypes.STRING(20),
                allowNull: false,
                validate: { isIn: [LEAD_PLATFORMS] },
            },
            name: { type: DataTypes.STRING, allowNull: false }, // display, e.g. "PRS Google Ads"
            externalAccountId: { type: DataTypes.STRING }, // ad account id / ServiceM8 account uuid
            webhookSecret: { type: DataTypes.STRING }, // verifies incoming webhook calls
            // Tokens, page ids, form ids — whatever the platform needs.
            credentials: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
            // Platform-specific settings, e.g. field-mapping overrides.
            config: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
            // Future: leads from this connection skip the review queue and
            // become stage-1 opportunities immediately.
            autoConvert: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
            lastEventAt: { type: DataTypes.DATE }, // last webhook received — connection health
        },
        {
            tableName: "integration_connections",
            indexes: [
                { fields: ["business_unit_id"] },
                { fields: ["platform", "external_account_id"] },
            ],
        }
    );

    IntegrationConnection.associate = (db) => {
        IntegrationConnection.belongsTo(db.BusinessUnit, { foreignKey: "businessUnitId", as: "businessUnit" });
        IntegrationConnection.hasMany(db.InboundLead, { foreignKey: "connectionId", as: "leads" });
    };

    return IntegrationConnection;
};
