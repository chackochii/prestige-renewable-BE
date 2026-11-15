import { Router } from "express";
import * as loans from "../modules/finance/controller/loanRequestController.js";
import tokenValidator from "../middleware/tokenValidator.js";
import requirePermission from "../middleware/requirePermission.js";
import { requireUnitAccess } from "../middleware/requireUnitAccess.js";
import { uploadSingleFile } from "../middleware/upload.js";

const router = Router();

router.use(tokenValidator);

// Finance applications submitted by sales (loans.create) and reviewed by
// finance (loans.update). A representative sees the applications they are on;
// finance and management see the unit's. Records outside the caller's units
// answer 404.
router.get("/", requirePermission("loans.read"), requireUnitAccess((req) => req.query.businessUnitId), loans.getAll); // ?businessUnitId=&status=&open=1&salesRepId=&opportunityId=&search=&page=&pageSize= → rows + counts
router.post("/", requirePermission("loans.create"), loans.create); // { opportunityId, loanAmount, depositAmount?, termMonths?, financier?, applicationDate?, notes?, salesRepId? }
router.get("/:id", requirePermission("loans.read"), loans.getOne); // with messages and attachments
router.patch("/:id", requirePermission("loans.read"), loans.update); // the rep on it (while open) or finance
router.post("/:id/review", requirePermission("loans.update"), loans.review); // { status, comments?, financierReference?, financierResponse? }
router.post("/:id/messages", requirePermission("loans.read"), loans.reply); // { body } — finance ↔ representative
router.post("/:id/attachments", requirePermission("loans.read"), uploadSingleFile, loans.attach); // multipart file (+ note?) — the financier's response
router.delete("/:id", requirePermission("loans.delete"), loans.remove); // { reason? }

export default router;
