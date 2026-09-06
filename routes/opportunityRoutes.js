import { Router } from "express";
import {
    getAll,
    getOne,
    create,
    update,
    advance,
    remove,
} from "../modules/opportunity/controller/opportunityController.js";
import tokenValidator from "../middleware/tokenValidator.js";
import requirePermission from "../middleware/requirePermission.js";

const router = Router();

// Guarded by the leads.* permissions from the RBAC catalog — who holds
// them is edited on the roles screen, not here.
router.get("/", tokenValidator, requirePermission("leads.read"), getAll); // ?businessUnitId=&stage=&lifecycle=&search=&page=&pageSize=
router.post("/", tokenValidator, requirePermission("leads.create"), create); // lead payload + businessUnitId
router.get("/:id", tokenValidator, requirePermission("leads.read"), getOne);
router.patch("/:id", tokenValidator, requirePermission("leads.update"), update); // lead fields, all optional
router.post("/:id/advance", tokenValidator, requirePermission("leads.update"), advance); // next enabled stage; gates apply
router.delete("/:id", tokenValidator, requirePermission("leads.delete"), remove); // stage-1 records only

export default router;
