import * as suppliers from "../service/supplierService.js";
import * as credit from "../service/supplierCreditService.js";
import { userHasPermission } from "../../role/service/roleService.js";
import asyncHandler from "../../../utils/asyncHandler.js";
import { successResponse } from "../../../utils/apiResponse.js";

// Credit details (limits, balances) are management's and procurement's to see — the
// same people who may see purchase prices.
const seesCredit = (req) => userHasPermission(req.user, "pricing.cost.read");
const managesCredit = (req) => userHasPermission(req.user, "suppliers.credit.manage");

export const getAll = asyncHandler(async (req, res) => {
    successResponse(res, await suppliers.listSuppliers(req.query, { withCredit: await seesCredit(req) }));
});

export const getOne = asyncHandler(async (req, res) => {
    successResponse(res, { data: await suppliers.getSupplier(req.params.id, { withCredit: await seesCredit(req) }) });
});

export const create = asyncHandler(async (req, res) => {
    successResponse(res, { data: await suppliers.createSupplier(req.body, req.user, req.activity, { canManageCredit: await managesCredit(req) }) }, 201);
});

export const update = asyncHandler(async (req, res) => {
    const [canManageCredit, withCredit] = await Promise.all([managesCredit(req), seesCredit(req)]);
    successResponse(res, { data: await suppliers.updateSupplier(req.params.id, req.body, req.user, req.activity, { canManageCredit, withCredit }) });
});

export const updateCredit = asyncHandler(async (req, res) => {
    successResponse(res, { data: await suppliers.updateSupplierCredit(req.params.id, req.body, req.user, req.activity) });
});

export const remove = asyncHandler(async (req, res) => {
    await suppliers.deleteSupplier(req.params.id, req.user, req.activity);

    successResponse(res, { message: "Supplier deleted" });
});

// ---- Credit ------------------------------------------------------------------

export const creditOverview = asyncHandler(async (req, res) => {
    successResponse(res, await credit.creditOverview(req.query));
});

export const getCredit = asyncHandler(async (req, res) => {
    successResponse(res, { data: await credit.getSupplierCredit(req.params.id) });
});

export const addTransaction = asyncHandler(async (req, res) => {
    successResponse(res, { data: await credit.recordTransaction(req.params.id, req.body, req.user, req.activity) }, 201);
});

export const removeTransaction = asyncHandler(async (req, res) => {
    successResponse(res, { data: await credit.deleteTransaction(req.params.id, req.params.transactionId, req.user, req.activity) });
});

export const remind = asyncHandler(async (req, res) => {
    successResponse(res, { data: await credit.sendSupplierReminder(req.params.id, req.body, req.user, req.activity) });
});
