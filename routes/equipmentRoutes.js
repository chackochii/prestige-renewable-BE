import { Router } from "express";
import * as equipment from "../modules/equipment/controller/equipmentController.js";
import tokenValidator from "../middleware/tokenValidator.js";
import requirePermission from "../middleware/requirePermission.js";

const router = Router();

router.use(tokenValidator);

// Equipment, supplier prices and margins. Everyone signed in reads the list —
// but what they see depends on pricing.cost.read: with it, purchase prices,
// margins and the supplier breakdown (management, procurement); without it,
// the sales price list only (sales). Changes need equipment.update.
const manage = requirePermission("equipment.update");

router.get("/", equipment.getAll); // ?categoryId=&kind=&supplierId=&search=&includeInactive=&unpriced=&page=&pageSize=
router.get("/price-list", equipment.getPriceList); // sales prices by category — what sales sees
router.post("/", manage, equipment.create); // { name, categoryId?, sku?, brand?, model?, unit?, marginPct?, salesPriceOverride?, preferredSupplierId?, suppliers?: [{ supplierId, unitCost, … }] }
router.get("/:id", equipment.getOne);
router.patch("/:id", manage, equipment.update);
router.delete("/:id", manage, equipment.remove);
router.patch("/:id/margin", manage, equipment.setMargin); // { marginPct?, salesPriceOverride? } — null resets
router.post("/:id/suppliers", manage, equipment.setSupplierPrice); // { supplierId, unitCost, supplierSku?, leadTimeDays?, minOrderQty?, validFrom?, validTo?, notes?, isPreferred? }
router.put("/:id/suppliers/:supplierId", manage, equipment.setSupplierPrice); // same body, supplier in the path
router.delete("/:id/suppliers/:supplierId", manage, equipment.removeSupplierPrice);

export default router;
