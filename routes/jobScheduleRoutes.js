import { Router } from "express";
import * as delivery from "../modules/delivery/controller/deliveryController.js";
import tokenValidator from "../middleware/tokenValidator.js";
import { requireAnyPermission } from "../middleware/requirePermission.js";
import { requireUnitAccess } from "../middleware/requireUnitAccess.js";

const router = Router();

router.use(tokenValidator);

// Job scheduling: each job goes to the team that does that kind of work
// (GET /routing). Anyone working delivery reads the calendar; operations,
// procurement and site managers schedule (construction.update /
// procurement.update / warranty.update). The crew moves its own jobs through
// in progress → completed with construction.checklists.update.
const read = requireAnyPermission("construction.read", "procurement.read", "warranty.read", "approvals.read");
const schedule = requireAnyPermission("construction.update", "procurement.update", "warranty.update");
const work = requireAnyPermission("construction.update", "procurement.update", "warranty.update", "construction.checklists.update");

router.get("/routing", delivery.jobRouting); // → { jobTypes: [{ type, team, teamLabel }], teams: [{ team, label, roles }] }
router.get("/", read, requireUnitAccess((req) => req.query.businessUnitId), delivery.listJobs); // ?businessUnitId=&team=&jobType=&status=&open=1&assigneeId=&mine=1&opportunityId=&projectId=&from=&to=&page=&pageSize=
router.post("/", schedule, delivery.createJob); // { businessUnitId?, opportunityId?, projectId?, title, jobType, scheduledStart, scheduledEnd?, assigneeId?, team?, location?, notes? }
router.get("/:id", read, delivery.getJob);
router.patch("/:id", schedule, delivery.updateJob); // any create field, status
router.post("/:id/assign", schedule, delivery.assignJob); // { assigneeId | null }
router.post("/:id/status", work, delivery.setJobStatus); // { status: scheduled|in_progress|completed|cancelled, note? }
router.delete("/:id", schedule, delivery.deleteJob);

export default router;
