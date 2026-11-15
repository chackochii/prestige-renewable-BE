import * as equipment from "../service/equipmentService.js";
import * as categories from "../service/categoryService.js";
import { userHasPermission } from "../../role/service/roleService.js";
import asyncHandler from "../../../utils/asyncHandler.js";
import { successResponse } from "../../../utils/apiResponse.js";

/** Purchase prices and margins are shown only to pricing.cost.read holders. */
const showCost = (req) => userHasPermission(req.user, "pricing.cost.read");

// ---- Equipment ---------------------------------------------------------------

export const getAll = asyncHandler(async (req, res) => {
    const result = await equipment.listEquipment(req.query, { showCost: await showCost(req) });

    successResponse(res, result);
});

export const getPriceList = asyncHandler(async (req, res) => {
    successResponse(res, { data: await equipment.priceList() });
});

export const getOne = asyncHandler(async (req, res) => {
    successResponse(res, { data: await equipment.getEquipment(req.params.id, { showCost: await showCost(req) }) });
});

export const create = asyncHandler(async (req, res) => {
    successResponse(res, { data: await equipment.createEquipment(req.body, req.user, req.activity) }, 201);
});

export const update = asyncHandler(async (req, res) => {
    successResponse(res, { data: await equipment.updateEquipment(req.params.id, req.body, req.user, req.activity) });
});

export const setMargin = asyncHandler(async (req, res) => {
    successResponse(res, { data: await equipment.setMargin(req.params.id, req.body, req.user, req.activity) });
});

export const setSupplierPrice = asyncHandler(async (req, res) => {
    const body = req.params.supplierId ? { ...req.body, supplierId: req.params.supplierId } : req.body;
    successResponse(res, { data: await equipment.setSupplierPrice(req.params.id, body, req.user, req.activity) });
});

export const removeSupplierPrice = asyncHandler(async (req, res) => {
    successResponse(res, { data: await equipment.removeSupplierPrice(req.params.id, req.params.supplierId, req.user, req.activity) });
});

export const remove = asyncHandler(async (req, res) => {
    await equipment.deleteEquipment(req.params.id, req.user, req.activity);

    successResponse(res, { message: "Equipment deleted" });
});

// ---- Categories --------------------------------------------------------------

export const getCategories = asyncHandler(async (req, res) => {
    successResponse(res, { data: await categories.listCategories(req.query) });
});

export const getCategory = asyncHandler(async (req, res) => {
    successResponse(res, { data: await categories.getCategory(req.params.id) });
});

export const createCategory = asyncHandler(async (req, res) => {
    successResponse(res, { data: await categories.createCategory(req.body, req.user, req.activity) }, 201);
});

export const updateCategory = asyncHandler(async (req, res) => {
    successResponse(res, { data: await categories.updateCategory(req.params.id, req.body, req.user, req.activity) });
});

export const deactivateCategory = asyncHandler(async (req, res) => {
    successResponse(res, { data: await categories.deactivateCategory(req.params.id, req.user, req.activity) });
});

export const reactivateCategory = asyncHandler(async (req, res) => {
    successResponse(res, { data: await categories.reactivateCategory(req.params.id, req.user, req.activity) });
});

export const removeCategory = asyncHandler(async (req, res) => {
    await categories.deleteCategory(req.params.id, req.user, req.activity);

    successResponse(res, { message: "Category deleted" });
});
