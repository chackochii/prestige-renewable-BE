import {
    listRoles,
    listPermissions,
    setRolePermissions,
    createRole,
    updateRole,
    deleteRole,
    createPermission,
    updatePermission,
    deletePermission,
} from "../service/roleService.js";
import asyncHandler from "../../../utils/asyncHandler.js";
import { successResponse } from "../../../utils/apiResponse.js";

// Roles
export const getAll = asyncHandler(async (req, res) => {
    const roles = await listRoles();

    successResponse(res, { data: roles });
});

export const create = asyncHandler(async (req, res) => {
    const role = await createRole(req.body);

    successResponse(res, { data: role }, 201);
});

export const update = asyncHandler(async (req, res) => {
    const role = await updateRole(req.params.code, req.body);

    successResponse(res, { data: role });
});

export const remove = asyncHandler(async (req, res) => {
    await deleteRole(req.params.code);

    successResponse(res, { message: "Role deleted successfully" });
});

export const setPermissions = asyncHandler(async (req, res) => {
    const role = await setRolePermissions(req.params.code, req.body.permissionCodes);

    successResponse(res, { data: role });
});

// Permission catalog
export const getAllPermissions = asyncHandler(async (req, res) => {
    const permissions = await listPermissions();

    successResponse(res, { data: permissions });
});

export const addPermission = asyncHandler(async (req, res) => {
    const permission = await createPermission(req.body);

    successResponse(res, { data: permission }, 201);
});

export const editPermission = asyncHandler(async (req, res) => {
    const permission = await updatePermission(req.params.code, req.body);

    successResponse(res, { data: permission });
});

export const removePermission = asyncHandler(async (req, res) => {
    await deletePermission(req.params.code);

    successResponse(res, { message: "Permission deleted successfully" });
});
