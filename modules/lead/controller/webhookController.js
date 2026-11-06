// The platforms' deliveries. No token: the Meta signature and the Google key
// are the whole authority (see webhookService).
import asyncHandler from "../../../utils/asyncHandler.js";
import { errorResponse, successResponse } from "../../../utils/apiResponse.js";
import { googleDelivery, metaDelivery, metaVerification } from "../service/webhookService.js";

/** Meta's subscription handshake: answers the challenge as plain text, which is what Meta expects. */
export const metaVerify = (req, res) => {
    try {
        res.status(200).type("text/plain").send(metaVerification(req.query));
    } catch (err) {
        errorResponse(res, err.message, err.status ?? 500);
    }
};

export const metaReceive = asyncHandler(async (req, res) => {
    const summary = await metaDelivery({ rawBody: req.rawBody, signature: req.headers["x-hub-signature-256"], body: req.body });
    successResponse(res, { data: summary });
});

export const googleReceive = asyncHandler(async (req, res) => {
    successResponse(res, { data: await googleDelivery(req.body) });
});
