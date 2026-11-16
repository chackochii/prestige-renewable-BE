import { Router } from "express";
import * as skills from "../modules/aiSkill/controller/aiSkillController.js";
import tokenValidator from "../middleware/tokenValidator.js";
import requirePermission, { requireAnyPermission } from "../middleware/requirePermission.js";
import { uploadSingleFile } from "../middleware/upload.js";

const router = Router();

router.use(tokenValidator);

// AI skills (Admin → AI skills): the instructions, reference files and
// calculator settings the AI works to when it drafts a proposal. Admin readers
// see them; skills.manage (Business Owner, SysAdmin; ADM) changes them. Every
// change is a new version that can be restored.
const read = requireAnyPermission("skills.manage", "admin.read");
const manage = requirePermission("skills.manage");

router.get("/", read, skills.getAll); // → [{ id, key, name, purpose, isActive, version, contentLength, references, settings }]
router.post("/", manage, skills.create); // { key, name, description?, purpose?, content, settings? } — starts inactive
router.get("/:id", read, skills.getOne); // with content, references (names), settings (merged) and defaults
router.patch("/:id", manage, skills.update); // { name?, description?, content?, settings?, isActive?, note? }
router.post("/:id/settings/reset", manage, skills.resetSettings);
router.post("/:id/files", manage, uploadSingleFile, skills.upload); // multipart file (.md .txt .json .py .csv .yaml) + target: content | reference + note?
router.get("/:id/references/:name", read, skills.getReference); // → { name, size, content }
router.put("/:id/references/:name", manage, skills.updateReference); // { content, note? }
router.delete("/:id/references/:name", manage, skills.removeReference);
router.get("/:id/versions", read, skills.versions);
router.get("/:id/versions/:version", read, skills.version);
router.post("/:id/versions/:version/restore", manage, skills.restore);
router.delete("/:id", manage, skills.remove); // not the active one

export default router;
