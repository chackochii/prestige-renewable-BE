import {
    listDnspNetworks,
    createDnspNetwork,
    updateDnspNetwork,
    deleteDnspNetwork,
} from "../service/dnspNetworkService.js";
import asyncHandler from "../../../utils/asyncHandler.js";
import { successResponse } from "../../../utils/apiResponse.js";

export const getAll = asyncHandler(async (req, res) => {
    const networks = await listDnspNetworks();

    successResponse(res, { data: networks });
});

export const create = asyncHandler(async (req, res) => {
    const network = await createDnspNetwork(req.body);

    successResponse(res, { data: network }, 201);
});

export const update = asyncHandler(async (req, res) => {
    const network = await updateDnspNetwork(req.params.id, req.body);

    successResponse(res, { data: network });
});

export const remove = asyncHandler(async (req, res) => {
    await deleteDnspNetwork(req.params.id);

    successResponse(res, { message: "DNSP network deleted successfully" });
});
