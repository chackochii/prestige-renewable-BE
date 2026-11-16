import { Router } from "express";
import activityRoutes from "./activityRoutes.js";
import aiSkillRoutes from "./aiSkillRoutes.js";
import businessUnitRoutes from "./businessUnitRoutes.js";
import customerPaymentRoutes from "./customerPaymentRoutes.js";
import dashboardRoutes from "./dashboardRoutes.js";
import equipmentCategoryRoutes from "./equipmentCategoryRoutes.js";
import equipmentRoutes from "./equipmentRoutes.js";
import installationRoutes from "./installationRoutes.js";
import jobScheduleRoutes from "./jobScheduleRoutes.js";
import loanRequestRoutes from "./loanRequestRoutes.js";
import projectRoutes from "./projectRoutes.js";
import quoteApprovalRoutes from "./quoteApprovalRoutes.js";
import supplierRoutes from "./supplierRoutes.js";
import catalogRoutes from "./catalogRoutes.js";
import collaborationRoutes from "./collaborationRoutes.js";
import dnspNetworkRoutes from "./dnspNetworkRoutes.js";
import inboundLeadRoutes from "./inboundLeadRoutes.js";
import integrationRoutes from "./integrationRoutes.js";
import notificationRoutes from "./notificationRoutes.js";
import opportunityRoutes from "./opportunityRoutes.js";
import pageRoutes from "./pageRoutes.js";
import publicRoutes from "./publicRoutes.js";
import referrerRoutes from "./referrerRoutes.js";
import roleRoutes from "./roleRoutes.js";
import userRoutes from "./userRoutes.js";
import webhookRoutes from "./webhookRoutes.js";

const router = Router();

router.get("/", (req, res) => {
    res.json({ message: "API Working" });
});

router.use("/activity", activityRoutes); // the activity log
router.use("/ai-skills", aiSkillRoutes); // Admin → AI skills: the proposal skill, its files and calculator settings
router.use("/business-units", businessUnitRoutes);
router.use("/customer-payments", customerPaymentRoutes); // what customers owe, GST included
router.use("/dashboard", dashboardRoutes); // the central dashboard and the team view previews
router.use("/equipment", equipmentRoutes); // equipment, supplier prices, margins, the sales price list
router.use("/equipment-categories", equipmentCategoryRoutes);
router.use("/installations", installationRoutes); // completed installations
router.use("/jobs", jobScheduleRoutes); // job scheduling by team
router.use("/loan-requests", loanRequestRoutes); // finance applications
router.use("/projects", projectRoutes); // project status
router.use("/quote-approvals", quoteApprovalRoutes); // the Senior Sales approval queue
router.use("/suppliers", supplierRoutes); // suppliers and supplier credit
router.use("/catalog", catalogRoutes);
router.use("/collaboration", collaborationRoutes);
router.use("/dnsp-networks", dnspNetworkRoutes);
router.use("/inbound-leads", inboundLeadRoutes); // the lead inbox (ad-platform leads awaiting review)
router.use("/integrations", integrationRoutes); // lead connections (admin)
router.use("/notifications", notificationRoutes);
router.use("/opportunities", opportunityRoutes);
router.use("/pages", pageRoutes);
router.use("/public", publicRoutes); // no token: website enquiry form
router.use("/referrers", referrerRoutes);
router.use("/roles", roleRoutes);
router.use("/users", userRoutes);
router.use("/webhooks", webhookRoutes); // no token: Meta / Google Ads deliveries, verified by signature / key

export default router;
