// Where the ad platforms deliver leads. No tokenValidator on purpose: Meta
// signs each delivery with the app secret and Google sends the form's key,
// and webhookService checks both. app.js parses these bodies with the raw
// bytes kept (req.rawBody) so the Meta signature can be verified.
//
// The limits are per address and generous — Meta delivers in bursts and
// retries — and only bound a flood from one source; a rejected delivery is
// retried by the platform later.
import { Router } from "express";
import { googleReceive, metaReceive, metaVerify } from "../modules/lead/controller/webhookController.js";
import rateLimit from "../middleware/rateLimit.js";

const router = Router();

const metaLimit = rateLimit({ name: "webhook-meta", windowMs: 15 * 60 * 1000, max: 1000 });
const googleLimit = rateLimit({ name: "webhook-google", windowMs: 15 * 60 * 1000, max: 300 });

router.get("/meta", metaLimit, metaVerify); // ?hub.mode=subscribe&hub.verify_token=&hub.challenge= → the challenge
router.post("/meta", metaLimit, metaReceive); // { object: "page", entry: [{ changes: [{ field: "leadgen", value }] }] } → { received, filed, … }
router.post("/google-ads", googleLimit, googleReceive); // { lead_id, google_key, user_column_data, … } → { leadId, created, isTest }

export default router;
