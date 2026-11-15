import { Router } from "express";
import { getAll, getForEntity } from "../modules/activity/controller/activityController.js";
import tokenValidator from "../middleware/tokenValidator.js";
import requirePermission from "../middleware/requirePermission.js";

const router = Router();

router.use(tokenValidator);

// The activity log: who made each change, when, and from where. Rows in the
// caller's business units (ADM: all), newest first.
router.get("/", requirePermission("activity.read"), getAll); // ?businessUnitId=&entityType=&entityId=&actorId=&action=&source=&from=&to=&search=&page=&pageSize=
router.get("/entities/:type/:id", requirePermission("activity.read"), getForEntity); // one record's trail

export default router;
