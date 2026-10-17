import { Router } from "express";
import { getAll, create, update, remove } from "../modules/dnsp/controller/dnspNetworkController.js";
import tokenValidator from "../middleware/tokenValidator.js";
import requireSuperAdmin from "../middleware/requireSuperAdmin.js";

const router = Router();

router.use(tokenValidator);

// DNSP networks for the DNSP application (CL-07). Reference data: any
// signed-in user reads it (the approvals checklist needs it); only the
// system administrator maintains it.
router.get("/", getAll);
router.post("/", requireSuperAdmin, create); // { name, state?, isActive?, sortOrder? }
router.patch("/:id", requireSuperAdmin, update); // any of { name, state, isActive, sortOrder }
router.delete("/:id", requireSuperAdmin, remove);

export default router;
