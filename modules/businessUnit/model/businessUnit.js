export default (sequelize, DataTypes) => {
    const BusinessUnit = sequelize.define(
        "BusinessUnit",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            code: { type: DataTypes.STRING(10), allowNull: false, unique: true }, // PRS, PCC, PCI, IP
            name: { type: DataTypes.STRING, allowNull: false },
            legalName: { type: DataTypes.STRING },
            status: {
                type: DataTypes.STRING(20),
                allowNull: false,
                defaultValue: "configured",
                validate: { isIn: [["active", "configured", "inactive"]] },
            },
            timezone: { type: DataTypes.STRING, allowNull: false, defaultValue: "Australia/Sydney" },
            // Pricing below this margin % requires director approval
            marginFloor: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 20 },
            // Billing milestone percentages; must sum to 100. Editable per unit via the config API.
            billingSplit: {
                type: DataTypes.JSONB,
                allowNull: false,
                defaultValue: [
                    { key: "deposit", label: "Deposit", percent: 20 },
                    { key: "delivery", label: "Delivery", percent: 40 },
                    { key: "final", label: "Final", percent: 40 },
                ],
            },
            // Referrer commission per involvement tier; rate is a fraction (0.02 = 2%)
            commissionTiers: {
                type: DataTypes.JSONB,
                allowNull: false,
                defaultValue: [
                    { key: "lead_only", label: "Lead only", rate: 0.02 },
                    { key: "lead_sales_support", label: "Lead + sales support", rate: 0.035 },
                    { key: "lead_full_sales", label: "Lead + full sales", rate: 0.05 },
                ],
            },
            // SLA days per pipeline stage 1–9 plus the approvals window
            slaDays: {
                type: DataTypes.JSONB,
                allowNull: false,
                defaultValue: { 1: 3, 2: 5, 3: 7, 4: 10, 5: 15, 6: 10, 7: 20, 8: 7, 9: 5, approval: 15 },
            },
            // Per-unit notification priority overrides: { "<event key>": "high" }.
            // Events not named here keep the default in notificationEvents.js.
            notificationPriorities: {
                type: DataTypes.JSONB,
                allowNull: false,
                defaultValue: {},
            },
            // Pipeline stages this unit uses. Numbers stay stable (1–9); disabled
            // stages are skipped, not renumbered, so slaDays and reporting line up.
            enabledStages: {
                type: DataTypes.JSONB,
                allowNull: false,
                defaultValue: [1, 2, 3, 4, 5, 6, 7, 8, 9],
            },
            // External approvals gathered at stage 5, e.g. [{ key: "council", label: "Council / DA" }].
            // Empty array = this unit has no external approvals section.
            approvalTypes: {
                type: DataTypes.JSONB,
                allowNull: false,
                defaultValue: [
                    { key: "council", label: "Council / DA" },
                    { key: "dnsp", label: "DNSP grid connection" },
                    { key: "strata", label: "Facility / strata" },
                    { key: "rebate", label: "Rebate pre-approval" },
                ],
            },
            // Free-form per-unit data: industry-specific fields, branding,
            // contacts — anything a unit needs beyond the structured config.
            metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
            // Stage 7 substages, e.g. [{ key: "7a", label: "Pre-work site check" }].
            // Empty array = this unit skips site works.
            siteWorkSubstages: {
                type: DataTypes.JSONB,
                allowNull: false,
                defaultValue: [
                    { key: "7a", label: "Pre-work site check" },
                    { key: "7b", label: "Civil / enabling works" },
                    { key: "7c", label: "Site readiness" },
                    { key: "7d", label: "Installation" },
                    { key: "7e", label: "Commissioning" },
                ],
            },
        },
        { tableName: "business_units" }
    );

    BusinessUnit.associate = (db) => {
        BusinessUnit.hasMany(db.Opportunity, { foreignKey: "businessUnitId", as: "opportunities" });
        BusinessUnit.belongsToMany(db.User, {
            through: db.UserBusinessUnit,
            foreignKey: "businessUnitId",
            otherKey: "userId",
            as: "users",
        });
    };

    return BusinessUnit;
};
