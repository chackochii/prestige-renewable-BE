import { Router } from "express";
import * as delivery from "../modules/delivery/controller/deliveryController.js";
import tokenValidator from "../middleware/tokenValidator.js";
import requirePermission, { requireAnyPermission } from "../middleware/requirePermission.js";
import { requireUnitAccess } from "../middleware/requireUnitAccess.js";

const router = Router();

router.use(tokenValidator);

// Completed installations. Recorded by operations and site managers
// (construction.update); finance updates the invoice status (invoicing.update).
const read = requireAnyPermission("construction.read", "invoicing.read", "warranty.read");
const write = requireAnyPermission("construction.update", "invoicing.update");

router.get("/", read, requireUnitAccess((req) => req.query.businessUnitId), delivery.listInstallations); // ?businessUnitId=&invoiceStatus=&paymentMethod=&opportunityId=&from=&to=&search=&page=&pageSize= → rows + counts
router.post("/", requirePermission("construction.update"), delivery.recordInstallation); // { opportunityId, installationDate?, jobDescription?, installerId?, jobScheduleId?, signedQuoteVersionId?, paymentMethod?, invoiceStatus?, invoiceNumber?, notes? }
router.get("/:id", read, delivery.getInstallation);
router.patch("/:id", write, delivery.updateInstallation); // { installationDate?, jobDescription?, installerId?, signedQuoteVersionId?, paymentMethod?, invoiceStatus?, invoiceNumber?, notes? }
router.delete("/:id", requirePermission("construction.approve"), delivery.deleteInstallation);

export default router;
