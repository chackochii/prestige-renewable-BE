import { Router } from "express";
import {
    getAll,
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

// Reads and writes are scoped in the service: ADM works on everyone, other
// admin.* holders only on users in their own business units — and can never
// touch or create administrator accounts.
router.get("/", tokenValidator, getAll); // ?role=&status=&businessUnitId=&search=&page=&pageSize=
// Body: { name, email, password, roles: ["SMM", ...], title?, phone?,
//         status?, businessUnitIds?, referrerId? }
router.post("/", tokenValidator, requirePermission("admin.create"), create);
router.get("/:id", tokenValidator, getOne);
router.patch("/:id", tokenValidator, requirePermission("admin.update"), update); // same fields as create, all optional; no password here
router.patch("/:id/password", tokenValidator, requirePermission("admin.update"), changePassword); // { password } — admin reset
router.delete("/:id", tokenValidator, requirePermission("admin.delete"), remove); // soft delete

export default router;
