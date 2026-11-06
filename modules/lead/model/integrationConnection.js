// A connected lead source: one ad account (Google/Meta/LinkedIn) or
// ServiceM8 account, owned by ONE business unit — leads arriving through the
// connection inherit that unit. Connecting a new account is a row, not code:
// the webhook layer looks the connection up by platform + external account id
// (Meta: the Facebook Page id) or by webhook secret (Google Ads: the key set
// on the lead form) and files leads under it.
export const LEAD_PLATFORMS = ["google_ads", "meta_ads", "linkedin_ads", "servicem8"];

/** Platforms the webhook layer handles today (modules/lead/service/webhookService.js). */
export const SUPPORTED_PLATFORMS = ["meta_ads", "google_ads"];

export const PLATFORM_LABELS = {
    google_ads: "Google Ads",
    meta_ads: "Meta Ads",
    linkedin_ads: "LinkedIn Ads",
    servicem8: "ServiceM8",
};

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
            externalAccountId: { type: DataTypes.STRING }, // Meta: Page id · Google: customer id (optional) · ServiceM8: account uuid
            webhookSecret: { type: DataTypes.STRING }, // verifies incoming webhook calls (Google Ads: the form's key)
            // Tokens, page ids, form ids — whatever the platform needs. Secrets
            // are sealed with utils/secretBox before they are stored.
            credentials: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
            // Platform-specific settings, e.g. { fieldMap: { "<form field key>": "<column>" } }.
            config: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
            // Leads from this connection skip the review queue and become
            // stage-1 opportunities the moment they arrive.
            autoConvert: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
            lastEventAt: { type: DataTypes.DATE }, // last webhook received — connection health
            lastSyncAt: { type: DataTypes.DATE }, // last successful poll (Meta) — the poll's cursor
            lastError: { type: DataTypes.TEXT }, // last platform error, cleared by the next success
            lastErrorAt: { type: DataTypes.DATE },
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
