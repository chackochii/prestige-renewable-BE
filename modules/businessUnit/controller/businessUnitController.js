import {
    listBusinessUnits,
    getBusinessUnit,
    createBusinessUnit,
    updateBusinessUnit,
    deleteBusinessUnit,
    getBusinessUnitConfig,
    updateBusinessUnitConfig,
} from "../service/businessUnitService.js";
import asyncHandler from "../../../utils/asyncHandler.js";
import { successResponse } from "../../../utils/apiResponse.js";

// Scoped to the requesting user: assigned units only, everything for ADM.
export const getAll = asyncHandler(async (req, res) => {
    const units = await listBusinessUnits(req.user);

    successResponse(res, { data: units });
});

export const getOne = asyncHandler(async (req, res) => {
    const unit = await getBusinessUnit(req.params.id);

    successResponse(res, { data: unit });
});

export const create = asyncHandler(async (req, res) => {
    const unit = await createBusinessUnit(req.body);

    successResponse(res, { data: unit }, 201);
});

export const update = asyncHandler(async (req, res) => {
    const unit = await updateBusinessUnit(req.params.id, req.body);

    successResponse(res, { data: unit });
});

export const remove = asyncHandler(async (req, res) => {
    await deleteBusinessUnit(req.params.id);

    successResponse(res, { message: "Business unit deleted successfully" });
});

export const getConfig = asyncHandler(async (req, res) => {
    const config = await getBusinessUnitConfig(req.params.id);

    successResponse(res, { data: config });
});

export const updateConfig = asyncHandler(async (req, res) => {
    const config = await updateBusinessUnitConfig(req.params.id, req.body);

    successResponse(res, { data: config });
});
