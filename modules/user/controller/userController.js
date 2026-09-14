import {
    listUsers,
    listDirectory,
    getUserForActor,
    getUserWithPermissions,
    createUser,
    updateUser,
    resetPassword,
    deleteUser,
    loginUser,
} from "../service/userService.js";
import asyncHandler from "../../../utils/asyncHandler.js";
import { successResponse } from "../../../utils/apiResponse.js";

export const login = asyncHandler(async (req, res) => {
    const { email, password } = req.body;

    const { token, user } = await loginUser({ email, password });

    successResponse(res, { token, user });
});

// Current user, resolved from the bearer token (tokenValidator sets req.user)
export const me = asyncHandler(async (req, res) => {
    const user = await getUserWithPermissions(req.user.id);

    successResponse(res, { data: user });
});

export const getAll = asyncHandler(async (req, res) => {
    const { role, status, businessUnitId, search, page, pageSize } = req.query;

    // Scoped to the requesting user: directors see their units' users only.
    const result = await listUsers(
        {
            filters: { role, status, businessUnitId, search },
            pagination: { page: Number(page) || 1, pageSize: Number(pageSize) || 25 },
        },
        req.user ?? null
    );

    successResponse(res, result);
});

// People picker list for one business unit — names and roles only.
export const directory = asyncHandler(async (req, res) => {
    const users = await listDirectory({ businessUnitId: req.query.businessUnitId }, req.user ?? null);

    successResponse(res, { data: users });
});

export const getOne = asyncHandler(async (req, res) => {
    const user = await getUserForActor(req.params.id, req.user ?? null);

    successResponse(res, { data: user });
});

export const create = asyncHandler(async (req, res) => {
    const user = await createUser(req.body, req.user ?? null);

    successResponse(res, { data: user }, 201);
});

export const update = asyncHandler(async (req, res) => {
    const user = await updateUser(req.params.id, req.body, req.user ?? null);

    successResponse(res, { data: user });
});

export const changePassword = asyncHandler(async (req, res) => {
    await resetPassword(req.params.id, req.body.password, req.user ?? null);

    successResponse(res, { message: "Password updated successfully" });
});

export const remove = asyncHandler(async (req, res) => {
    await deleteUser(req.params.id, req.user ?? null);

    successResponse(res, { message: "User deleted successfully" });
});
