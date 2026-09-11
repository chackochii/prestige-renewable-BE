import { Router } from "express";
import { getAll } from "../modules/catalog/controller/catalogController.js";
import tokenValidator from "../middleware/tokenValidator.js";

const router = Router();

// Product catalog for the quote builder — reference data, open to any
// signed-in user (prices are the business's own list, not customer-facing).
router.get("/", tokenValidator, getAll);

export default router;
