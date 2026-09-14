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
import rateLimit from "../middleware/rateLimit.js";

const router = Router();

// Login is unauthenticated, so it gets the same per-IP limiter as the public
// form: blunts credential stuffing and caps how many timing samples one
// address can collect. Looser than the form because an office usually shares
// one address. Set "trust proxy" if the API sits behind a reverse proxy.
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 15,
    message: "Too many login attempts, try again in a few minutes.",
});

router.post("/login", loginLimiter, login); // { email, password } → { token, user }
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
