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

// Scoped list: the requesting user's assigned units (deny-by-default);
// ADM sees every unit.
router.get("/", tokenValidator, getAll);
// Unit lifecycle is strictly superadmin — requireSuperAdmin cannot be
// granted to other roles through the permission editor.
router.post("/", tokenValidator, requireSuperAdmin, create);
router.get("/:id", getOne);
router.patch("/:id", tokenValidator, requireSuperAdmin, update); // { name?, legalName?, timezone?, status? }
router.delete("/:id", tokenValidator, requireSuperAdmin, remove); // only units with no opportunities
// Master config: billingSplit, commissionTiers, approvalTypes,
// siteWorkSubstages, enabledStages, slaDays, marginFloor, metadata
router.get("/:id/config", getConfig);
router.patch("/:id/config", updateConfig);
// Page toggles: which registry pages this unit runs. Reads are open to any
// signed-in user; edits need admin.update (ADM bypasses in code).
router.get("/:id/pages", tokenValidator, getForUnit);
router.put("/:id/pages", tokenValidator, requirePermission("admin.update"), setForUnit); // { pages: [{ code, enabled }] }

export default router;
