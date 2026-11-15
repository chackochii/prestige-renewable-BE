import { Router } from "express";
import * as leadManagement from "../modules/opportunity/controller/leadManagementController.js";
import tokenValidator from "../middleware/tokenValidator.js";
import { requireAnyPermission } from "../middleware/requirePermission.js";
import { requireUnitAccess } from "../middleware/requireUnitAccess.js";

const router = Router();

router.use(tokenValidator);

// The approvers' queue across jobs: quotes waiting on a Senior Sales decision
// (default), or any status. Approvers see the queue; a representative can
// follow their own submissions with ?mine=1.
router.get("/", requireAnyPermission("quotes.approve", "leads.update", "estimation.update"), requireUnitAccess((req) => req.query.businessUnitId), leadManagement.quoteApprovalQueue); // ?businessUnitId=&status=pending|resubmitted|approved|rejected|all&mine=1&page=&pageSize=

export default router;
