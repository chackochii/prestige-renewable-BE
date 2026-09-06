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

// Roles
export const getAll = asyncHandler(async (req, res) => {
    const roles = await listRoles();

    res.status(200).json({ success: true, data: roles });
});

export const create = asyncHandler(async (req, res) => {
    const role = await createRole(req.body);

    res.status(201).json({ success: true, data: role });
});

export const update = asyncHandler(async (req, res) => {
    const role = await updateRole(req.params.code, req.body);

    res.status(200).json({ success: true, data: role });
});

export const remove = asyncHandler(async (req, res) => {
    await deleteRole(req.params.code);

    res.status(200).json({ success: true, message: "Role deleted successfully" });
});

export const setPermissions = asyncHandler(async (req, res) => {
    const role = await setRolePermissions(req.params.code, req.body.permissionCodes);

    res.status(200).json({ success: true, data: role });
});

// Permission catalog
export const getAllPermissions = asyncHandler(async (req, res) => {
    const permissions = await listPermissions();

    res.status(200).json({ success: true, data: permissions });
});

export const addPermission = asyncHandler(async (req, res) => {
    const permission = await createPermission(req.body);

    res.status(201).json({ success: true, data: permission });
});

export const editPermission = asyncHandler(async (req, res) => {
    const permission = await updatePermission(req.params.code, req.body);

    res.status(200).json({ success: true, data: permission });
});

export const removePermission = asyncHandler(async (req, res) => {
    await deletePermission(req.params.code);

    res.status(200).json({ success: true, message: "Permission deleted successfully" });
});
