import { Router } from "express";
import { dashboard, teamView } from "../modules/dashboard/controller/dashboardController.js";
import tokenValidator from "../middleware/tokenValidator.js";
import { requireAnyPermission } from "../middleware/requirePermission.js";
import { requireUnitAccess } from "../middleware/requireUnitAccess.js";

const router = Router();

router.use(tokenValidator);

// The central dashboard. Each section appears only for callers who can read
// that area; the route itself needs dashboards.read (or admin.read).
router.get("/", requireAnyPermission("dashboards.read", "admin.read"), requireUnitAccess((req) => req.query.businessUnitId), dashboard); // ?businessUnitId= (required) → { unit, generatedAt, sections }
// The Procurement and Operations team views, as those teams see them —
// management (admin.read) or the team itself.
router.get("/views/:team", requireUnitAccess((req) => req.query.businessUnitId), teamView); // team: procurement | operations; ?businessUnitId=

export default router;
