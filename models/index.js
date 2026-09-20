// Central model registry — imports every module's model and wires associations.
import { DataTypes } from "sequelize";
import { sequelize } from "../config/db.js";

import defineBusinessUnit from "../modules/businessUnit/model/businessUnit.js";
import defineRole from "../modules/role/model/role.js";
import definePermission from "../modules/role/model/permission.js";
import defineRolePermission from "../modules/role/model/rolePermission.js";
import defineUser from "../modules/user/model/user.js";
import defineUserBusinessUnit from "../modules/user/model/userBusinessUnit.js";
import defineAppPage from "../modules/page/model/appPage.js";
import defineBusinessUnitPage from "../modules/page/model/businessUnitPage.js";
import defineIntegrationConnection from "../modules/lead/model/integrationConnection.js";
import defineInboundLead from "../modules/lead/model/inboundLead.js";
import defineReferrer from "../modules/referrer/model/referrer.js";
import defineOpportunity from "../modules/opportunity/model/opportunity.js";
import defineOpportunityHistory from "../modules/opportunity/model/opportunityHistory.js";
import defineQuote from "../modules/opportunity/model/quote.js";
import defineQuoteItem from "../modules/opportunity/model/quoteItem.js";
import defineQuoteCost from "../modules/opportunity/model/quoteCost.js";
import defineQuoteVersion from "../modules/opportunity/model/quoteVersion.js";
import defineCatalogItem from "../modules/catalog/model/catalogItem.js";
import defineEstimate from "../modules/opportunity/model/estimate.js";
import defineEstimateOption from "../modules/opportunity/model/estimateOption.js";
import defineProposal from "../modules/opportunity/model/proposal.js";
import defineVariation from "../modules/opportunity/model/variation.js";
import defineApproval from "../modules/opportunity/model/approval.js";
import definePurchaseOrder from "../modules/opportunity/model/purchaseOrder.js";
import defineSiteWorkSubstage from "../modules/opportunity/model/siteWorkSubstage.js";
import defineRebate from "../modules/opportunity/model/rebate.js";
import defineBillingRequest from "../modules/billing/model/billingRequest.js";
import defineDocument from "../modules/document/model/document.js";
import defineAuditLog from "../modules/audit/model/auditLog.js";
import defineNotification from "../modules/notification/model/notification.js";
import defineCampaign from "../modules/campaign/model/campaign.js";
import defineCollaborationRequest from "../modules/collaboration/model/collaborationRequest.js";
import defineCollaborationProgress from "../modules/collaboration/model/collaborationProgress.js";
import defineCollaborationAttachment from "../modules/collaboration/model/collaborationAttachment.js";
import defineCollaborationEvent from "../modules/collaboration/model/collaborationEvent.js";

const db = { sequelize };

// Core entities
db.BusinessUnit = defineBusinessUnit(sequelize, DataTypes);
db.Role = defineRole(sequelize, DataTypes);
db.Permission = definePermission(sequelize, DataTypes);
db.RolePermission = defineRolePermission(sequelize, DataTypes);
db.User = defineUser(sequelize, DataTypes);
db.UserBusinessUnit = defineUserBusinessUnit(sequelize, DataTypes);
db.AppPage = defineAppPage(sequelize, DataTypes);
db.BusinessUnitPage = defineBusinessUnitPage(sequelize, DataTypes);
db.Referrer = defineReferrer(sequelize, DataTypes);
db.Campaign = defineCampaign(sequelize, DataTypes);
db.Opportunity = defineOpportunity(sequelize, DataTypes);
db.OpportunityHistory = defineOpportunityHistory(sequelize, DataTypes);
db.Quote = defineQuote(sequelize, DataTypes);
db.QuoteItem = defineQuoteItem(sequelize, DataTypes);
db.QuoteCost = defineQuoteCost(sequelize, DataTypes);
db.QuoteVersion = defineQuoteVersion(sequelize, DataTypes);
db.CatalogItem = defineCatalogItem(sequelize, DataTypes);

// Lead ingestion (ad platforms & ServiceM8)
db.IntegrationConnection = defineIntegrationConnection(sequelize, DataTypes);
db.InboundLead = defineInboundLead(sequelize, DataTypes);

// Quoting
db.Estimate = defineEstimate(sequelize, DataTypes);
db.EstimateOption = defineEstimateOption(sequelize, DataTypes);
db.Proposal = defineProposal(sequelize, DataTypes);
db.Variation = defineVariation(sequelize, DataTypes);

// Delivery
db.Approval = defineApproval(sequelize, DataTypes);
db.PurchaseOrder = definePurchaseOrder(sequelize, DataTypes);
db.SiteWorkSubstage = defineSiteWorkSubstage(sequelize, DataTypes);
db.Rebate = defineRebate(sequelize, DataTypes);

// Billing & system
db.BillingRequest = defineBillingRequest(sequelize, DataTypes);
db.Document = defineDocument(sequelize, DataTypes);
db.AuditLog = defineAuditLog(sequelize, DataTypes);
db.Notification = defineNotification(sequelize, DataTypes);

// Cross-department requests and assignments
db.CollaborationRequest = defineCollaborationRequest(sequelize, DataTypes);
db.CollaborationProgress = defineCollaborationProgress(sequelize, DataTypes);
db.CollaborationAttachment = defineCollaborationAttachment(sequelize, DataTypes);
db.CollaborationEvent = defineCollaborationEvent(sequelize, DataTypes);

Object.values(db)
    .filter((model) => typeof model?.associate === "function")
    .forEach((model) => model.associate(db));

export const {
    BusinessUnit,
    Role,
    Permission,
    RolePermission,
    User,
    UserBusinessUnit,
    AppPage,
    BusinessUnitPage,
    Referrer,
    Campaign,
    Opportunity,
    OpportunityHistory,
    Quote,
    QuoteItem,
    QuoteCost,
    QuoteVersion,
    CatalogItem,
    IntegrationConnection,
    InboundLead,
    Estimate,
    EstimateOption,
    Proposal,
    Variation,
    Approval,
    PurchaseOrder,
    SiteWorkSubstage,
    Rebate,
    BillingRequest,
    Document,
    AuditLog,
    Notification,
    CollaborationRequest,
    CollaborationProgress,
    CollaborationAttachment,
    CollaborationEvent,
} = db;

export { sequelize };
export default db;
