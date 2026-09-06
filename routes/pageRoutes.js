import { Router } from "express";
import { getAll, create, update, remove } from "../modules/page/controller/pageController.js";
import tokenValidator from "../middleware/tokenValidator.js";
import requirePermission from "../middleware/requirePermission.js";

const router = Router();

router.use(tokenValidator);

// Every signed-in user reads the registry — the sidebar is built from it.
router.get("/", getAll);

// Registry management (adding pages is data, not code — but a page only works
// once the frontend has a route for it, hence system pages guard their paths).
router.post("/", requirePermission("admin.create"), create); // { code, label, path, sortOrder?, viewPermissionCode? }
router.patch("/:code", requirePermission("admin.update"), update); // { label?, path?, sortOrder?, viewPermissionCode? }
router.delete("/:code", requirePermission("admin.delete"), remove); // non-system pages only

export default router;
