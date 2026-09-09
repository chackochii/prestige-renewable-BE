import { Router } from "express";
import {
    getAll,
    directory,
    getOne,
    create,
    update,
    changePassword,
    remove,
    login,
    me,
} from "../modules/user/controller/userController.js";
import tokenValidator from "../middleware/tokenValidator.js";
import requirePermission from "../middleware/requirePermission.js";

const router = Router();

router.post("/login", login); // { email, password } → { token, user }
router.get("/me", tokenValidator, me); // current user from the bearer token

// People directory for pickers: id, name, title, roles, status of the active
// users in one business unit the caller is assigned to. Open to any signed-in
// user — it carries no contact details or login history. Must be mounted
// before /:id.
router.get("/directory", tokenValidator, directory); // ?businessUnitId= (required)

// Full user records (email, phone, last login, unit assignments) need
// admin.read; writes need the matching admin.* action. Everything is scoped
// in the service: ADM works on everyone, other admin.* holders only on users
// in their own business units — and can never touch or create administrator
// accounts.
router.get("/", tokenValidator, requirePermission("admin.read"), getAll); // ?role=&status=&businessUnitId=&search=&page=&pageSize=
// Body: { name, email, password, roles: ["SMM", ...], title?, phone?,
//         status?, businessUnitIds?, referrerId? }
router.post("/", tokenValidator, requirePermission("admin.create"), create);
router.get("/:id", tokenValidator, requirePermission("admin.read"), getOne);
router.patch("/:id", tokenValidator, requirePermission("admin.update"), update); // same fields as create, all optional; no password here
router.patch("/:id/password", tokenValidator, requirePermission("admin.update"), changePassword); // { password } — admin reset
router.delete("/:id", tokenValidator, requirePermission("admin.delete"), remove); // soft delete

export default router;
