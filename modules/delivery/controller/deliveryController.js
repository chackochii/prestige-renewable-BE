import * as projects from "../service/projectService.js";
import * as jobs from "../service/jobScheduleService.js";
import * as installations from "../service/installationService.js";
import asyncHandler from "../../../utils/asyncHandler.js";
import { successResponse } from "../../../utils/apiResponse.js";

// ---- Projects ----------------------------------------------------------------

export const listProjects = asyncHandler(async (req, res) => {
    successResponse(res, await projects.listProjects(req.query, req.user));
});

export const getProject = asyncHandler(async (req, res) => {
    successResponse(res, { data: await projects.getProject(req.params.id, req.user) });
});

export const getProjectForOpportunity = asyncHandler(async (req, res) => {
    successResponse(res, { data: await projects.getProjectForOpportunity(req.params.opportunityId, req.user) });
});

export const createProject = asyncHandler(async (req, res) => {
    successResponse(res, { data: await projects.createProject(req.body, req.user, req.activity) }, 201);
});

export const updateProject = asyncHandler(async (req, res) => {
    successResponse(res, { data: await projects.updateProject(req.params.id, req.body, req.user, req.activity) });
});

export const deleteProject = asyncHandler(async (req, res) => {
    await projects.deleteProject(req.params.id, req.user, req.activity);

    successResponse(res, { message: "Project deleted" });
});

// ---- Job scheduling ----------------------------------------------------------

export const jobRouting = asyncHandler(async (req, res) => {
    successResponse(res, { data: jobs.routing() });
});

export const listJobs = asyncHandler(async (req, res) => {
    successResponse(res, await jobs.listJobs(req.query, req.user));
});

export const getJob = asyncHandler(async (req, res) => {
    successResponse(res, { data: await jobs.getJob(req.params.id, req.user) });
});

export const createJob = asyncHandler(async (req, res) => {
    successResponse(res, { data: await jobs.createJob(req.body, req.user, req.activity) }, 201);
});

export const updateJob = asyncHandler(async (req, res) => {
    successResponse(res, { data: await jobs.updateJob(req.params.id, req.body, req.user, req.activity) });
});

export const assignJob = asyncHandler(async (req, res) => {
    successResponse(res, { data: await jobs.assignJob(req.params.id, req.body, req.user, req.activity) });
});

export const setJobStatus = asyncHandler(async (req, res) => {
    successResponse(res, { data: await jobs.setJobStatus(req.params.id, req.body, req.user, req.activity) });
});

export const deleteJob = asyncHandler(async (req, res) => {
    await jobs.deleteJob(req.params.id, req.user, req.activity);

    successResponse(res, { message: "Job deleted" });
});

// ---- Installations -----------------------------------------------------------

export const listInstallations = asyncHandler(async (req, res) => {
    successResponse(res, await installations.listInstallations(req.query, req.user));
});

export const getInstallation = asyncHandler(async (req, res) => {
    successResponse(res, { data: await installations.getInstallation(req.params.id, req.user) });
});

export const recordInstallation = asyncHandler(async (req, res) => {
    successResponse(res, { data: await installations.recordInstallation(req.body, req.user, req.activity) }, 201);
});

export const updateInstallation = asyncHandler(async (req, res) => {
    successResponse(res, { data: await installations.updateInstallation(req.params.id, req.body, req.user, req.activity) });
});

export const deleteInstallation = asyncHandler(async (req, res) => {
    await installations.deleteInstallation(req.params.id, req.user, req.activity);

    successResponse(res, { message: "Installation deleted" });
});
