// Lead connections — the ad accounts each business unit takes leads from
// (Administration → Lead connections). Guarded by the admin.* permissions,
// like the rest of unit administration; ADM bypasses in code.
import { Router } from "express";
import { create, getOne, list, remove, rotate, setup, sync, test, update } from "../modules/lead/controller/integrationConnectionController.js";
import tokenValidator from "../middleware/tokenValidator.js";
import requirePermission from "../middleware/requirePermission.js";
import { requireUnitAccess } from "../middleware/requireUnitAccess.js";

const router = Router();

router.use(tokenValidator);

const read = requirePermission("admin.read");
const write = requirePermission("admin.update");

router.get("/setup", read, setup); // → { webhookUrls, meta: { appSecretSet, verifyToken, tokensSealed } }
router.get("/connections", read, requireUnitAccess((req) => req.query.businessUnitId), list); // ?businessUnitId= → [connection]
router.post("/connections", requirePermission("admin.create"), requireUnitAccess((req) => req.body?.businessUnitId), create); // { businessUnitId, platform, name, externalAccountId?, credentials?, config?, autoConvert?, isActive? }
router.get("/connections/:id", read, getOne);
router.patch("/connections/:id", write, update); // any of name, externalAccountId, credentials, config, autoConvert, isActive
router.delete("/connections/:id", requirePermission("admin.delete"), remove); // the leads it filed stay
router.post("/connections/:id/rotate-secret", write, rotate); // Google: a new key
router.post("/connections/:id/test", write, test); // Meta: { ok, page, forms } · Google: { ok, webhookUrl, hint }
router.post("/connections/:id/sync", write, sync); // Meta: pull leads since the last poll → { forms, fetched, created, converted }

export default router;
