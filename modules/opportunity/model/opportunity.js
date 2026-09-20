// Pipeline stages:
// 1 Lead · 2 Estimation · 3 Proposal · 4 Sales closure · 5 Approvals
// 6 Procurement · 7 Site works · 8 Billing · 9 Handover

// Lead-checklist option keys. These mirror
// prestige-fe/src/features/leads/propertyOptions.js — keep them in step, the
// screens label them from the same keys.
export const SERVICE_REQUIREMENTS = ["solar", "battery", "both"];
export const STOREY_OPTIONS = ["single", "double"];
export const ROOF_TYPES = ["tin", "tile", "colorbond"];
export const ELECTRICAL_PHASES = ["1_phase", "3_phase"];
export const INSTALL_TIMEFRAMES = ["asap", "1_3_months", "3_6_months", "6_months_plus", "undecided"];

/**
 * The optional checklist rows estimation inherits, stored as one object on
 * the record. Anything not listed here is dropped on write — see
 * prestige-fe/src/constants/estimationInput.js for the same list.
 */
export const ESTIMATION_INPUT_KEYS = [
    // Project & site
    "siteType", "preSiteInspectionRequired", "siteCrewAssigneeId", "inspectionStatus",
    "siteVisitCompleted", "sitePhotosOnFile", "roofMeasurements",
    // Existing electrical
    "existingElectrical", "switchboardLocation", "switchboardCondition", "switchboardUpgrade",
    "loadRequirements",
    // Existing system (retrofit only)
    "isRetrofit", "existingSolarKw", "existingInverter", "existingBattery", "existingSystemNotes",
    // New system specification
    "panelQty", "panelCapacityW", "preferredBrands", "inverterBrandModel", "batteryBrandModel",
    "batteryCapacityKwh", "backupRequirement", "backupDuration",
    // Installation requirements
    "mountingRequirements", "cableRequirements", "siteConstraints", "specialRequirements",
    // Compliance
    "permits", "vppDiscussed", "vppEligibility", "vppNotes", "permitNotes", "meterRequirements",
    "drawingsOnFile", "drawingsNotes",
    // Customer
    "inclusions", "exclusions", "noteForEstimator",
];

export default (sequelize, DataTypes) => {
    const Opportunity = sequelize.define(
        "Opportunity",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            // e.g. PRS-26-0008 — unique among non-deleted rows (partial index opportunities_number_active_uq)
            number: { type: DataTypes.STRING(20), allowNull: false },
            businessUnitId: { type: DataTypes.INTEGER, allowNull: false },
            stage: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, validate: { min: 1, max: 9 } },
            lifecycle: {
                type: DataTypes.STRING(20),
                allowNull: false,
                defaultValue: "Active",
                validate: { isIn: [["Active", "Won", "Lost", "Closed"]] },
            },
            variationPending: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            // Snapshot of the unit's margin floor when the opportunity was created
            marginFloor: { type: DataTypes.DECIMAL(5, 2) },

            // Lead source & referrer commission. The automated channels are
            // set when an inbound_leads row is converted (see inboundLeadId).
            leadSource: {
                type: DataTypes.STRING(20),
                allowNull: false,
                defaultValue: "internal",
                validate: {
                    isIn: [["internal", "inbound", "referrer", "google_ads", "meta_ads", "linkedin_ads", "servicem8"]],
                },
            },
            // The inbound_leads row this opportunity was converted from —
            // campaign/ad attribution is one join away.
            inboundLeadId: { type: DataTypes.INTEGER, allowNull: true },
            referrerId: { type: DataTypes.INTEGER, allowNull: true },
            // Marketing campaign the lead is attributed to (null = exception / organic)
            campaignId: { type: DataTypes.INTEGER, allowNull: true },
            leadType: {
                type: DataTypes.STRING(20),
                allowNull: true,
                validate: { isIn: [["residential", "commercial", "industrial", "other"]] },
            },
            // Where the lead came from in the salesperson's words (who referred,
            // which campaign, …) — the structured referrer link is referrerId.
            leadSourceDetails: { type: DataTypes.STRING(500) },
            involvementTier: {
                type: DataTypes.STRING(30),
                allowNull: true,
                validate: { isIn: [["lead_only", "lead_sales_support", "lead_full_sales"]] },
            },

            // Customer
            customerLegalName: { type: DataTypes.STRING },
            customerTradingName: { type: DataTypes.STRING },
            customerAbn: { type: DataTypes.STRING(20) },
            customerEmail: { type: DataTypes.STRING },
            customerPhone: { type: DataTypes.STRING },
            customerBillingAddress: { type: DataTypes.STRING },
            customerFirstName: { type: DataTypes.STRING(100) },
            customerLastName: { type: DataTypes.STRING(100) },
            // Blank means English — see prestige-fe/src/constants/languages.js.
            preferredLanguage: { type: DataTypes.STRING(40) },
            billingSameAsSite: { type: DataTypes.STRING(3), validate: { isIn: [["yes", "no"]] } },
            customerComments: { type: DataTypes.TEXT },
            customerIntentConfirmed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            customerBudget: { type: DataTypes.DECIMAL(12, 2) },
            businessOffers: { type: DataTypes.TEXT },

            // Site
            siteLine1: { type: DataTypes.STRING },
            siteSuburb: { type: DataTypes.STRING },
            siteState: { type: DataTypes.STRING(10) },
            sitePostcode: { type: DataTypes.STRING(10) },
            siteJurisdiction: { type: DataTypes.STRING(10) },
            siteContact: { type: DataTypes.STRING },
            siteAccessNotes: { type: DataTypes.TEXT },

            // Primary contact
            contactName: { type: DataTypes.STRING },
            contactRole: { type: DataTypes.STRING },
            contactEmail: { type: DataTypes.STRING },
            contactPhone: { type: DataTypes.STRING },

            // Qualification (captured at stage 1; editable while the record lives)
            qualification: {
                type: DataTypes.STRING(20),
                allowNull: false,
                defaultValue: "qualified",
                validate: { isIn: [["qualified", "nurture", "disqualified"]] },
            },
            qualificationAuthority: { type: DataTypes.STRING },
            qualificationTiming: { type: DataTypes.STRING },
            // Early sizing by the salesperson — acceptedValue is the contracted outcome
            estimatedValue: { type: DataTypes.DECIMAL(14, 2), allowNull: true },
            nextAction: { type: DataTypes.STRING },
            nextActionDueAt: { type: DataTypes.DATEONLY },

            // Energy profile
            energyAnnualKwh: { type: DataTypes.DECIMAL(14, 2), allowNull: true },
            energyHasBills: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            energyNotes: { type: DataTypes.TEXT },

            // Owners
            leadOwnerId: { type: DataTypes.INTEGER, allowNull: true },
            estimatorId: { type: DataTypes.INTEGER, allowNull: true },
            salespersonId: { type: DataTypes.INTEGER, allowNull: true },
            deliveryOwnerId: { type: DataTypes.INTEGER, allowNull: true },

            // SLA tracking for the current stage
            slaStartedAt: { type: DataTypes.DATE },
            slaDueAt: { type: DataTypes.DATE },

            // Site works window & contractors (substages live in site_work_substages)
            installWindowStart: { type: DataTypes.DATEONLY },
            installWindowEnd: { type: DataTypes.DATEONLY },
            electricalContractor: { type: DataTypes.STRING },
            civilContractor: { type: DataTypes.STRING },

            // Commercial outcome
            acceptedValue: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
            feedback: { type: DataTypes.TEXT },
            notes: { type: DataTypes.TEXT },

            // Per-stage working data. Small, rarely queried, owned by one
            // screen each — kept as JSONB rather than a table per blob.
            meetings: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] }, // [{ id, at, attendees, outcome, nextStep, actorId }]
            inspection: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} }, // { measurements, constraints }
            estimateNotes: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} }, // { procurementNeeds, missingInfo, riskMapping }
            externalQuotes: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] }, // [{ id, supplier, url, note }]
            jobBaseline: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} }, // { approvedBudget, budgetConfirmed, costCategories, keyDates, notes, budgetLockedAt }
            service: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} }, // { reviewRequested, referralCaptured, actions, feedbackText }
            postWorkEnquiries: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] }, // [{ id, date, description, status }]
            additionalCosts: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] }, // [{ id, description, amount }]
            siteWorksMeta: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} }, // { insuranceDetails, actualCost }
            laborCostFinal: { type: DataTypes.DECIMAL(14, 2), allowNull: true },
            operationalComplete: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            financialComplete: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

            // Closure / handover
            closureChecklistComplete: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            closureWarrantyContact: { type: DataTypes.STRING },
            closureFutureEngagement: { type: DataTypes.STRING },
            closedAt: { type: DataTypes.DATE },

            // ---- Lead capture checklist (stage 1) ----------------------------
            // What Estimation needs before a lead can be marked a potential
            // client — see opportunityService.qualificationChecklistItems.
            siteMapUrl: { type: DataTypes.STRING(1000) },
            // null = nobody has answered "did the client have to be contacted?"
            // yet; the lead checklist asks for an answer before handover.
            needsClientContact: { type: DataTypes.BOOLEAN, allowNull: true },
            contactAttempts: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] }, // [{ method, contactedAt, reached, reason }]
            hasOwnerDiscount: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            ownerDiscountName: { type: DataTypes.STRING },
            ownerDiscountAmount: { type: DataTypes.DECIMAL(14, 2), allowNull: true },
            unassignedReason: { type: DataTypes.TEXT }, // why no salesperson is assigned yet
            needsClientVisit: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            clientVisitReason: { type: DataTypes.TEXT },
            operationalCoordinatorId: { type: DataTypes.INTEGER, allowNull: true }, // runs the client visit
            customFields: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] }, // [{ label, value }]
            notPotentialReason: { type: DataTypes.TEXT }, // when qualification = disqualified

            // ---- Estimation workflow (stage 2) --------------------------------
            // null = question not answered yet; see estimationService.
            estimationRequirementsReceived: { type: DataTypes.BOOLEAN, allowNull: true },
            estimationRequirementsChecklist: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] }, // ticked checklist keys
            estimationOnHoldReason: { type: DataTypes.TEXT }, // what sales still owes (when received = false)
            estimationClientInfoNeeded: { type: DataTypes.BOOLEAN, allowNull: true },
            estimationChecklistValues: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} }, // { key: answer }
            estimationPreSiteInspectionRequired: { type: DataTypes.BOOLEAN, allowNull: true },
            estimationSiteVisitAssigneeId: { type: DataTypes.INTEGER, allowNull: true },
            estimationSiteVisitCompleted: { type: DataTypes.BOOLEAN, allowNull: true },

            // ---- Lead checklist: what sales confirms with the customer ------
            // The mandatory rows gate "potential client" (see assertCanQualify);
            // the option keys mirror prestige-fe/src/features/leads/propertyOptions.js.
            serviceRequirement: { type: DataTypes.STRING(20), validate: { isIn: [SERVICE_REQUIREMENTS] } },
            propertyStoreys: { type: DataTypes.STRING(10), validate: { isIn: [STOREY_OPTIONS] } },
            roofType: { type: DataTypes.STRING(20), validate: { isIn: [ROOF_TYPES] } },
            electricalPhase: { type: DataTypes.STRING(10), validate: { isIn: [ELECTRICAL_PHASES] } },
            financeAssistance: { type: DataTypes.STRING(10), validate: { isIn: [["yes", "no"]] } },
            financeNotes: { type: DataTypes.TEXT },
            siteRequirementsNone: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            siteSpecificRequirements: { type: DataTypes.TEXT },
            preferredInstallTimeframe: { type: DataTypes.STRING(20), validate: { isIn: [INSTALL_TIMEFRAMES] } },
            preferredInstallLocation: { type: DataTypes.STRING(255) },

            // The optional checklist rows, carried to estimation as one object
            // (keys in ESTIMATION_INPUT_KEYS) rather than 40 columns nothing
            // else queries.
            estimationInput: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
            estimationInputsAcceptedAt: { type: DataTypes.DATE },
            estimationInputsAcceptedById: { type: DataTypes.INTEGER },

            // "Lead details changed": set when a handed-over lead is edited,
            // cleared when the estimator acknowledges it.
            leadEditedAt: { type: DataTypes.DATE },
            leadChangeSummary: { type: DataTypes.TEXT },
            leadChangeAcknowledgedAt: { type: DataTypes.DATE },
        },
        {
            tableName: "opportunities",
            paranoid: true, // soft delete — destroy() sets deleted_at, queries exclude deleted rows
            indexes: [
                { fields: ["business_unit_id"] },
                { fields: ["stage"] },
                { fields: ["referrer_id"] },
                { fields: ["lifecycle"] },
            ],
        }
    );

    Opportunity.associate = (db) => {
        Opportunity.belongsTo(db.BusinessUnit, { foreignKey: "businessUnitId", as: "businessUnit" });
        Opportunity.belongsTo(db.Referrer, { foreignKey: "referrerId", as: "referrer" });
        Opportunity.belongsTo(db.Campaign, { foreignKey: "campaignId", as: "campaign" });
        Opportunity.belongsTo(db.InboundLead, { foreignKey: "inboundLeadId", as: "inboundLead" });
        Opportunity.belongsTo(db.User, { foreignKey: "leadOwnerId", as: "leadOwner" });
        Opportunity.belongsTo(db.User, { foreignKey: "estimatorId", as: "estimator" });
        Opportunity.belongsTo(db.User, { foreignKey: "salespersonId", as: "salesperson" });
        Opportunity.belongsTo(db.User, { foreignKey: "deliveryOwnerId", as: "deliveryOwner" });
        Opportunity.belongsTo(db.User, { foreignKey: "operationalCoordinatorId", as: "operationalCoordinator" });
        Opportunity.hasMany(db.OpportunityHistory, { foreignKey: "opportunityId", as: "history" });
        Opportunity.belongsTo(db.User, { foreignKey: "estimationSiteVisitAssigneeId", as: "siteVisitAssignee" });
        Opportunity.hasOne(db.Quote, { foreignKey: "opportunityId", as: "quote" });

        Opportunity.hasMany(db.Estimate, { foreignKey: "opportunityId", as: "estimates" });
        Opportunity.hasMany(db.Proposal, { foreignKey: "opportunityId", as: "proposals" });
        Opportunity.hasMany(db.Variation, { foreignKey: "opportunityId", as: "variations" });
        Opportunity.hasMany(db.Approval, { foreignKey: "opportunityId", as: "approvals" });
        Opportunity.hasMany(db.PurchaseOrder, { foreignKey: "opportunityId", as: "purchaseOrders" });
        Opportunity.hasMany(db.SiteWorkSubstage, { foreignKey: "opportunityId", as: "siteWorkSubstages" });
        Opportunity.hasMany(db.Rebate, { foreignKey: "opportunityId", as: "rebates" });
        Opportunity.hasMany(db.BillingRequest, { foreignKey: "opportunityId", as: "billingRequests" });
        Opportunity.hasMany(db.Document, { foreignKey: "opportunityId", as: "documents" });
        Opportunity.hasMany(db.AuditLog, { foreignKey: "opportunityId", as: "auditLogs" });
        Opportunity.hasMany(db.Notification, { foreignKey: "opportunityId", as: "notifications" });
    };

    return Opportunity;
};
