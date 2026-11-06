// The lead inbox: automated leads from the ad platforms waiting for review
// (modules/lead). Reading the queue is reading leads; converting makes a lead,
// so it asks for leads.create; rejecting and reopening are lead edits.
import { Router } from "express";
import { convert, getOne, list, refresh, reject, reopen } from "../modules/lead/controller/inboundLeadController.js";
import tokenValidator from "../middleware/tokenValidator.js";
import requirePermission from "../middleware/requirePermission.js";
import { requireUnitAccess } from "../middleware/requireUnitAccess.js";

const router = Router();

router.use(tokenValidator);

const read = requirePermission("leads.read");
const write = requirePermission("leads.update");

// Unit scoping: the list names its unit and is checked here; every /:id route
// answers 404 for a lead outside the caller's units (inboundLeadService).
router.get("/", read, requireUnitAccess((req) => req.query.businessUnitId), list); // ?businessUnitId=&status=&source=&search=&page=&pageSize= → rows + counts
router.get("/:id", read, getOne); // → the lead with its answers and the opportunities already holding its contact details
router.post("/:id/convert", requirePermission("leads.create"), convert); // { overrides?: { …lead fields } } → { lead, opportunity }
router.post("/:id/reject", write, reject); // { reason? } → the lead
router.post("/:id/reopen", write, reopen); // rejected → pending
router.post("/:id/refresh", write, refresh); // Meta: fetch the answers again

export default router;
