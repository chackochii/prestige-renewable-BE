import { Router } from "express";
import * as suppliers from "../modules/equipment/controller/supplierController.js";
import tokenValidator from "../middleware/tokenValidator.js";
import requirePermission, { requireAnyPermission } from "../middleware/requirePermission.js";

const router = Router();

router.use(tokenValidator);

// Suppliers and supplier credit. Contact details: equipment.update. Credit
// limits and payment terms: management (suppliers.credit.manage). Purchases
// and payments: procurement (procurement.update) or management. Balances are
// shown to pricing.cost.read holders.
const manage = requirePermission("equipment.update");
const manageCredit = requirePermission("suppliers.credit.manage");
const seeCredit = requirePermission("pricing.cost.read");
const recordCredit = requireAnyPermission("procurement.update", "procurement.create", "suppliers.credit.manage");

router.get("/", suppliers.getAll); // ?search=&includeInactive=&page=&pageSize=
router.get("/credit", seeCredit, suppliers.creditOverview); // every supplier's limit, outstanding, available, overdue (+ totals)
router.post("/", manage, suppliers.create); // { name, contactName?, email?, phone?, address?, abn?, website?, notes?, creditLimit?*, paymentTermsDays?*, creditNotes?* } (* suppliers.credit.manage)
router.get("/:id", suppliers.getOne);
router.patch("/:id", manage, suppliers.update);
router.delete("/:id", manage, suppliers.remove); // 409 while prices or transactions exist
router.patch("/:id/credit", manageCredit, suppliers.updateCredit); // { creditLimit?, paymentTermsDays?, creditNotes? }
router.get("/:id/credit", seeCredit, suppliers.getCredit); // { supplier, summary, transactions }
router.post("/:id/transactions", recordCredit, suppliers.addTransaction); // { kind: purchase|payment|credit_note, amount, reference?, transactedAt?, dueAt?, note?, businessUnitId?, opportunityId?, purchaseOrderId? }
router.delete("/:id/transactions/:transactionId", manageCredit, suppliers.removeTransaction);
router.post("/:id/remind", recordCredit, suppliers.remind); // { note?, businessUnitId?, userIds? } → procurement and finance notified

export default router;
