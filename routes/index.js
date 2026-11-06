import { Router } from "express";
import businessUnitRoutes from "./businessUnitRoutes.js";
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

router.use("/business-units", businessUnitRoutes);
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
