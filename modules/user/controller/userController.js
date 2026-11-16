import {
    listUsers,
    listDirectory,
    getUserForActor,
    getUserWithPermissions,
    createUser,
    updateUser,
    resetPassword,
    resetPin,
    clearPin,
    setOwnPin,
    setOwnPassword,
    deleteUser,
    loginUser,
} from "../service/userService.js";
import asyncHandler from "../../../utils/asyncHandler.js";
import { successResponse } from "../../../utils/apiResponse.js";

export const login = asyncHandler(async (req, res) => {
    const { email, password, pin } = req.body;

    const { token, user, mustChangePin, mustChangePassword } = await loginUser({ email, password, pin }, req.activity);

    successResponse(res, { token, user, mustChangePin, mustChangePassword });
});

// The signed-in person sets their own password (first sign-in with a temporary
// one, or a change); answers with a full session token.
export const setMyPassword = asyncHandler(async (req, res) => {
    const { token, user } = await setOwnPassword(req.user.id, req.body, req.activity);

    successResponse(res, { token, user, message: "Password set" });
});

// The signed-in person sets or changes their own PIN; answers with a full session token.
export const setMyPin = asyncHandler(async (req, res) => {
    const { token, user } = await setOwnPin(req.user.id, req.body, req.activity);

    successResponse(res, { token, user, message: "PIN set" });
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

// People picker list for one business unit — names, roles and departments
// only; ?department= narrows it to one team.
export const directory = asyncHandler(async (req, res) => {
    const users = await listDirectory({ businessUnitId: req.query.businessUnitId, department: req.query.department }, req.user ?? null);

    successResponse(res, { data: users });
});

export const getOne = asyncHandler(async (req, res) => {
    const user = await getUserForActor(req.params.id, req.user ?? null);

    successResponse(res, { data: user });
});

export const create = asyncHandler(async (req, res) => {
    const user = await createUser(req.body, req.user ?? null, req.activity);

    // The temporary PIN rides beside the record, once, for the administrator to pass on.
    successResponse(res, { data: user, ...(user.temporaryPin ? { temporaryPin: user.temporaryPin } : {}) }, 201);
});

export const update = asyncHandler(async (req, res) => {
    const user = await updateUser(req.params.id, req.body, req.user ?? null, req.activity);

    successResponse(res, { data: user });
});

export const changePassword = asyncHandler(async (req, res) => {
    await resetPassword(req.params.id, req.body.password, req.user ?? null, req.activity);

    successResponse(res, { message: "Password updated successfully" });
});

// An administrator issues a (new) temporary PIN — returned once.
export const changePin = asyncHandler(async (req, res) => {
    const { temporaryPin, user } = await resetPin(req.params.id, req.body, req.user ?? null, req.activity);

    successResponse(res, { data: user, temporaryPin, message: "Temporary PIN issued — the user sets their own on first login" });
});

export const removePin = asyncHandler(async (req, res) => {
    await clearPin(req.params.id, req.user ?? null, req.activity);

    successResponse(res, { message: "PIN removed" });
});

export const remove = asyncHandler(async (req, res) => {
    await deleteUser(req.params.id, req.user ?? null, req.activity);

    successResponse(res, { message: "User deleted successfully" });
});
