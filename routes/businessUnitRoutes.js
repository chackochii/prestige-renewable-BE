import { Router } from "express";
import {
    getAll,
    getOne,
    create,
    update,
    remove,
    getConfig,
    updateConfig,
} from "../modules/businessUnit/controller/businessUnitController.js";
import { getForUnit, setForUnit } from "../modules/page/controller/pageController.js";
import tokenValidator from "../middleware/tokenValidator.js";
import requirePermission from "../middleware/requirePermission.js";
import requireSuperAdmin from "../middleware/requireSuperAdmin.js";

const router = Router();

// Every business-unit route needs a signed-in user. Applying the validator
// once here means a new route can never be mounted unauthenticated by
// accident (this file previously exposed GET /:id and the config routes
// to anyone).
router.use(tokenValidator);

// Scoped list: the requesting user's assigned units (deny-by-default);
// ADM sees every unit.
router.get("/", getAll);
// Unit lifecycle is strictly superadmin — requireSuperAdmin cannot be
// granted to other roles through the permission editor.
router.post("/", requireSuperAdmin, create);
router.get("/:id", getOne);
router.patch("/:id", requireSuperAdmin, update); // { name?, legalName?, timezone?, status? }
router.delete("/:id", requireSuperAdmin, remove); // only units with no opportunities
// Master config: billingSplit, commissionTiers, approvalTypes,
// siteWorkSubstages, enabledStages, slaDays, marginFloor, metadata.
// Reads are open to any signed-in user (the workspace needs them); edits
// need admin.update, matching the Unit settings screen (ADM bypasses in code).
router.get("/:id/config", getConfig);
router.patch("/:id/config", requirePermission("admin.update"), updateConfig);
// Page toggles: which registry pages this unit runs. Reads are open to any
// signed-in user; edits need admin.update (ADM bypasses in code).
router.get("/:id/pages", getForUnit);
router.put("/:id/pages", requirePermission("admin.update"), setForUnit); // { pages: [{ code, enabled }] }

export default router;
