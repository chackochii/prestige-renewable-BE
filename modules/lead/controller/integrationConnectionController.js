import asyncHandler from "../../../utils/asyncHandler.js";
import { successResponse } from "../../../utils/apiResponse.js";
import {
    createConnection,
    deleteConnection,
    getConnection,
    listConnections,
    metaSetup,
    rotateSecret,
    syncConnection,
    testConnection,
    updateConnection,
    webhookUrlFor,
} from "../service/integrationConnectionService.js";

/** What the admin needs to set the platforms up: the webhook URLs and whether the server-side Meta settings are in place. */
export const setup = asyncHandler(async (req, res) => {
    successResponse(res, {
        data: {
            webhookUrls: { meta_ads: webhookUrlFor("meta_ads"), google_ads: webhookUrlFor("google_ads") },
            meta: metaSetup(),
        },
    });
});

export const list = asyncHandler(async (req, res) => {
    successResponse(res, { data: await listConnections(req.query) });
});

export const getOne = asyncHandler(async (req, res) => {
    successResponse(res, { data: await getConnection(req.params.id, req.user) });
});

export const create = asyncHandler(async (req, res) => {
    successResponse(res, { data: await createConnection(req.body, req.user) }, 201);
});

export const update = asyncHandler(async (req, res) => {
    successResponse(res, { data: await updateConnection(req.params.id, req.body, req.user) });
});

export const remove = asyncHandler(async (req, res) => {
    await deleteConnection(req.params.id, req.user);
    successResponse(res, { message: "Connection removed" });
});

export const rotate = asyncHandler(async (req, res) => {
    successResponse(res, { data: await rotateSecret(req.params.id, req.user) });
});

export const test = asyncHandler(async (req, res) => {
    successResponse(res, { data: await testConnection(req.params.id, req.user) });
});

export const sync = asyncHandler(async (req, res) => {
    successResponse(res, { data: await syncConnection(req.params.id, req.user) });
});
