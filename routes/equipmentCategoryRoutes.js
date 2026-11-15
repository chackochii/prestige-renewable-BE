import { Router } from "express";
import * as equipment from "../modules/equipment/controller/equipmentController.js";
import tokenValidator from "../middleware/tokenValidator.js";
import requirePermission from "../middleware/requirePermission.js";

const router = Router();

router.use(tokenValidator);

// Equipment and service categories: category ID, item counts, active status.
// Anyone signed in reads them (the equipment list is grouped by them);
// renaming, deactivating, reactivating and removing need equipment.update.
const manage = requirePermission("equipment.update");

router.get("/", equipment.getCategories); // ?kind=equipment|service&includeInactive=1 → [{ id, code, name, kind, isActive, itemCount, activeItemCount }]
router.post("/", manage, equipment.createCategory); // { name, kind?, description?, sortOrder? }
router.get("/:id", equipment.getCategory);
router.patch("/:id", manage, equipment.updateCategory); // { name?, kind?, description?, sortOrder?, isActive? }
router.post("/:id/deactivate", manage, equipment.deactivateCategory);
router.post("/:id/reactivate", manage, equipment.reactivateCategory);
router.delete("/:id", manage, equipment.removeCategory); // 409 while items are filed under it

export default router;
