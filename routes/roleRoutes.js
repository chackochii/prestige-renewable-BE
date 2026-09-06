import { Router } from "express";
import {
    getAll,
    create,
    update,
    remove,
    setPermissions,
    getAllPermissions,
    addPermission,
    editPermission,
    removePermission,
} from "../modules/role/controller/roleController.js";
import tokenValidator from "../middleware/tokenValidator.js";
import requirePermission from "../middleware/requirePermission.js";

const router = Router();

router.use(tokenValidator);

// Reads are open to any signed-in user (the roles screen is read-only for
// admin.read holders); mutations require the matching admin.* action
// (ADM bypasses in code).
router.get("/", getAll);
router.get("/permissions", getAllPermissions);

router.post("/", requirePermission("admin.create"), create); // { code, name, description?, inheritsFrom?, permissionCodes? }
router.post("/permissions", requirePermission("admin.create"), addPermission); // { code, name, category? }
router.patch("/permissions/:code", requirePermission("admin.update"), editPermission); // { name?, category? }
router.delete("/permissions/:code", requirePermission("admin.delete"), removePermission); // custom permissions only
router.patch("/:code", requirePermission("admin.update"), update); // { name?, description?, isActive?, inheritsFrom? }
router.delete("/:code", requirePermission("admin.delete"), remove); // non-system, unassigned roles only
router.put("/:code/permissions", requirePermission("admin.update"), setPermissions);

export default router;
