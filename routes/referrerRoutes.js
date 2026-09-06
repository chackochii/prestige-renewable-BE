import { Router } from "express";
import { getAll } from "../modules/referrer/controller/referrerController.js";
import tokenValidator from "../middleware/tokenValidator.js";

const router = Router();

// Light directory read (id, organisation, contact, status) for attribution
// pickers — no payment details. Management routes ship with the referrers page.
router.get("/", tokenValidator, getAll); // ?status=active|inactive|all

export default router;
