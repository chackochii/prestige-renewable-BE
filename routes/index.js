import { Router } from "express";
import businessUnitRoutes from "./businessUnitRoutes.js";
import catalogRoutes from "./catalogRoutes.js";
import notificationRoutes from "./notificationRoutes.js";
import opportunityRoutes from "./opportunityRoutes.js";
import pageRoutes from "./pageRoutes.js";
import publicRoutes from "./publicRoutes.js";
import referrerRoutes from "./referrerRoutes.js";
import roleRoutes from "./roleRoutes.js";
import userRoutes from "./userRoutes.js";

const router = Router();

router.get("/", (req, res) => {
    res.json({ message: "API Working" });
});

router.use("/business-units", businessUnitRoutes);
router.use("/catalog", catalogRoutes);
router.use("/notifications", notificationRoutes);
router.use("/opportunities", opportunityRoutes);
router.use("/pages", pageRoutes);
router.use("/public", publicRoutes); // no token: website enquiry form
router.use("/referrers", referrerRoutes);
router.use("/roles", roleRoutes);
router.use("/users", userRoutes);

export default router;
