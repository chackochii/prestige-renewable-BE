import { Router } from "express";
import { getAll, getManaged, create, update, remove } from "../modules/catalog/controller/catalogController.js";
import tokenValidator from "../middleware/tokenValidator.js";
import requireSuperAdmin from "../middleware/requireSuperAdmin.js";

const router = Router();

router.use(tokenValidator);

// Product catalog for the quote builder — reference data, open to any
// signed-in user (prices are the business's own list, not customer-facing).
router.get("/", getAll);
// Maintained by the system administrator: the catalog is shared by every
// business unit, so no unit-level role may change it.
router.get("/manage", requireSuperAdmin, getManaged); // active and retired, with ids
router.post("/", requireSuperAdmin, create); // { name, unit?, brands: [{ name, unitPrice }], isActive?, sortOrder? }
router.patch("/:id", requireSuperAdmin, update); // any of { name, unit, brands, isActive, sortOrder }
router.delete("/:id", requireSuperAdmin, remove);

export default router;
