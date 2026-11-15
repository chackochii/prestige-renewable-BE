import { Router } from "express";
import * as delivery from "../modules/delivery/controller/deliveryController.js";
import tokenValidator from "../middleware/tokenValidator.js";
import requirePermission, { requireAnyPermission } from "../middleware/requirePermission.js";
import { requireUnitAccess } from "../middleware/requireUnitAccess.js";

const router = Router();

router.use(tokenValidator);

// Project status: signed jobs as operations tracks them. Read by anyone who
// follows delivery (sales follows its own deals too); operations updates them
// (construction.update / procurement.update). Records outside the caller's
// units answer 404.
const read = requireAnyPermission("construction.read", "procurement.read", "approvals.read", "leads.read");
const operate = requireAnyPermission("construction.update", "procurement.update", "approvals.update");

router.get("/", read, requireUnitAccess((req) => req.query.businessUnitId), delivery.listProjects); // ?businessUnitId=&status=&active=1&paymentType=&installationStatus=&procurementStatus=&repId=&search=&page=&pageSize= → rows + counts
router.post("/", operate, delivery.createProject); // { opportunityId, paymentType?, loanRequestId?, signedAt?, expectedInstallDate?, operationsOwnerId?, notes? }
router.get("/by-opportunity/:opportunityId", read, delivery.getProjectForOpportunity); // → the job's project or null
router.get("/:id", read, delivery.getProject); // with approvals, documents, signed quote, jobs, installations, payments, purchase orders
router.patch("/:id", operate, delivery.updateProject); // { status?, paymentType?, loanRequestId?, installationStatus?, installationProgressPct?, procurementStatus?, assignedRepId?, operationsOwnerId?, signedAt?, expectedInstallDate?, notes? }
router.delete("/:id", requirePermission("construction.approve"), delivery.deleteProject);

export default router;
