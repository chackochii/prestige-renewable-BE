import * as skills from "../service/aiSkillService.js";
import asyncHandler from "../../../utils/asyncHandler.js";
import { successResponse } from "../../../utils/apiResponse.js";

export const getAll = asyncHandler(async (req, res) => {
    successResponse(res, { data: await skills.listSkills() });
});

export const getOne = asyncHandler(async (req, res) => {
    successResponse(res, { data: await skills.getSkill(req.params.id) });
});

export const create = asyncHandler(async (req, res) => {
    successResponse(res, { data: await skills.createSkill(req.body, req.user, req.activity) }, 201);
});

export const update = asyncHandler(async (req, res) => {
    successResponse(res, { data: await skills.updateSkill(req.params.id, req.body, req.user, req.activity) });
});

export const resetSettings = asyncHandler(async (req, res) => {
    successResponse(res, { data: await skills.resetSettings(req.params.id, req.user, req.activity) });
});

export const upload = asyncHandler(async (req, res) => {
    const data = await skills.uploadSkillFile(req.params.id, req.file, { target: req.body?.target, note: req.body?.note }, req.user, req.activity);
    successResponse(res, { data }, 201);
});

export const getReference = asyncHandler(async (req, res) => {
    successResponse(res, { data: await skills.getReference(req.params.id, req.params.name) });
});

export const updateReference = asyncHandler(async (req, res) => {
    successResponse(res, { data: await skills.updateReference(req.params.id, req.params.name, req.body, req.user, req.activity) });
});

export const removeReference = asyncHandler(async (req, res) => {
    successResponse(res, { data: await skills.removeReference(req.params.id, req.params.name, req.user, req.activity) });
});

export const versions = asyncHandler(async (req, res) => {
    successResponse(res, { data: await skills.listVersions(req.params.id) });
});

export const version = asyncHandler(async (req, res) => {
    successResponse(res, { data: await skills.getVersion(req.params.id, req.params.version) });
});

export const restore = asyncHandler(async (req, res) => {
    successResponse(res, { data: await skills.restoreVersion(req.params.id, req.params.version, req.user, req.activity) });
});

export const remove = asyncHandler(async (req, res) => {
    await skills.deleteSkill(req.params.id, req.user, req.activity);

    successResponse(res, { message: "Skill deleted" });
});
