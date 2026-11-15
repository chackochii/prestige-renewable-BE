import { Router } from "express";
import * as payments from "../modules/finance/controller/customerPaymentController.js";
import tokenValidator from "../middleware/tokenValidator.js";
import requirePermission from "../middleware/requirePermission.js";
import { requireUnitAccess } from "../middleware/requireUnitAccess.js";

const router = Router();

router.use(tokenValidator);

// Amounts owed by customers, GST included, and the receipts against them.
// Guarded by the invoicing permissions (finance), the same module as billing.
router.get("/", requirePermission("invoicing.read"), requireUnitAccess((req) => req.query.businessUnitId), payments.getAll); // ?businessUnitId=&opportunityId=&projectId=&status=&outstanding=1&search=&page=&pageSize= → rows + totals
router.post("/", requirePermission("invoicing.create"), payments.create); // { opportunityId, description, amountEx | amountInc, gstRatePct?, milestone?, dueAt?, invoiceNumber?, projectId?, notes? }
router.get("/:id", requirePermission("invoicing.read"), payments.getOne);
router.patch("/:id", requirePermission("invoicing.update"), payments.update); // any create field; status: cancelled | unpaid
router.post("/:id/receipts", requirePermission("invoicing.update"), payments.addReceipt); // { amount, receivedAt?, method?, reference?, note? }
router.delete("/:id/receipts/:receiptId", requirePermission("invoicing.update"), payments.removeReceipt);
router.delete("/:id", requirePermission("invoicing.delete"), payments.remove); // only when nothing has been received

export default router;
