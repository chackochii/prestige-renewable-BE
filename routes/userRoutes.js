import { Router } from "express";
import {
    getAll,
    directory,
    getOne,
    create,
    update,
    changePassword,
    changePin,
    removePin,
    setMyPin,
    setMyPassword,
    remove,
    login,
    me,
} from "../modules/user/controller/userController.js";
import tokenValidator from "../middleware/tokenValidator.js";
import requirePermission from "../middleware/requirePermission.js";
import rateLimit from "../middleware/rateLimit.js";
import allowTokenScope from "../middleware/allowTokenScope.js";
import { PASSWORD_SETUP_SCOPE, PIN_SETUP_SCOPE } from "../utils/jwt.js";

const router = Router();

// Login is unauthenticated, so it gets the same per-IP limiter as the public
// form: blunts credential stuffing and caps how many timing samples one
// address can collect. Looser than the form because an office usually shares
// one address. Set "trust proxy" if the API sits behind a reverse proxy.
const loginLimiter = rateLimit({
    name: "login",
    windowMs: 15 * 60 * 1000,
    max: 15,
    message: "Too many login attempts, try again in a few minutes.",
});

router.post("/login", loginLimiter, login); // { email, password } or { email, pin } → { token, user, mustChangePin, mustChangePassword }
// These accept the set-up token a temporary-PIN or temporary-password login
// hands out, as well as a full session token: the person can see who they are
// and set their own PIN or password, and nothing else, until they do.
router.get("/me", allowTokenScope(PIN_SETUP_SCOPE, PASSWORD_SETUP_SCOPE), tokenValidator, me); // current user from the bearer token
router.post("/me/pin", allowTokenScope(PIN_SETUP_SCOPE), tokenValidator, setMyPin); // { pin, currentPin? | currentPassword? } → { token, user }
// { newPassword, currentPassword? } → { token, user } — currentPassword only when changing a password they chose themselves.
// Limited like the login: it checks a password too.
router.post("/me/password", loginLimiter, allowTokenScope(PASSWORD_SETUP_SCOPE), tokenValidator, setMyPassword);

// People directory for pickers: id, name, title, roles, status and
// departments (from the roles — collaboration DEPARTMENT_ROLES) of the active
// users in one business unit the caller is assigned to. Open to any signed-in
// user — it carries no contact details or login history. Must be mounted
// before /:id.
router.get("/directory", tokenValidator, directory); // ?businessUnitId= (required) &department=sales|operations|procurement|finance|admin

// Full user records (email, phone, last login, unit assignments) need
// admin.read; writes need the matching admin.* action. Everything is scoped
// in the service: ADM works on everyone, other admin.* holders only on users
// in their own business units — and can never touch or create administrator
// accounts.
router.get("/", tokenValidator, requirePermission("admin.read"), getAll); // ?role=&status=&businessUnitId=&search=&page=&pageSize=
// Body: { name, email, password? | temporaryPin? | issuePin?, roles: ["SMM", ...], title?, phone?,
//         (the password is temporary: the person chooses their own at first sign-in)
//         status?, businessUnitIds?, referrerId? } → { data: user, temporaryPin? } (the PIN is returned once)
router.post("/", tokenValidator, requirePermission("admin.create"), create);
router.get("/:id", tokenValidator, requirePermission("admin.read"), getOne);
router.patch("/:id", tokenValidator, requirePermission("admin.update"), update); // same fields as create, all optional; no password here
router.patch("/:id/password", tokenValidator, requirePermission("admin.update"), changePassword); // { password } — admin reset; temporary until the person sets their own
router.post("/:id/pin/reset", tokenValidator, requirePermission("admin.update"), changePin); // { temporaryPin? } → { data, temporaryPin } — a new temporary PIN
router.delete("/:id/pin", tokenValidator, requirePermission("admin.update"), removePin); // sign in with the password only
router.delete("/:id", tokenValidator, requirePermission("admin.delete"), remove); // soft delete

export default router;
