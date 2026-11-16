// User management. Required info to create a user: name, email, password and
// at least one role; optionally title, phone, status, business unit
// assignments (deny-by-default access — a user only works in units listed for
// them) and, for REF users, the referrer organisation their portal login
// belongs to. Role codes are validated against the roles table by the model,
// so roles created at runtime are immediately assignable.
import crypto from "node:crypto";
import { Op } from "sequelize";
import db from "../../../models/index.js";
import { SUPER_ROLE_CODE, listPermissionCodesForRoles } from "../../role/service/roleService.js";
import { DEPARTMENTS, departmentsForRoles } from "../../collaboration/model/collaborationRequest.js";
import { diff, recordActivity } from "../../activity/service/activityService.js";
import { hashPin } from "../model/user.js";
import { parseId } from "../../../utils/ids.js";
import { signPasswordSetupToken, signPinSetupToken, signToken } from "../../../utils/jwt.js";

const { User, BusinessUnit, UserBusinessUnit, Referrer, sequelize } = db;

const httpError = (status, message) => Object.assign(new Error(message), { status });

// ---------------------------------------------------------------------------
// PINs. A PIN is 4–8 digits. Administrators issue a temporary one when adding
// a team member (or on request); the person signs in with it and must set
// their own before the app lets them in (loginUser → pin_setup token).

const PIN_RE = /^\d{4,8}$/;
const TEMP_PIN_LENGTH = 6;

/** A fresh random temporary PIN — six digits, never all the same or a straight run. */
export const generateTemporaryPin = () => {
    for (;;) {
        const pin = String(crypto.randomInt(0, 10 ** TEMP_PIN_LENGTH)).padStart(TEMP_PIN_LENGTH, "0");
        if (!isWeakPin(pin)) return pin;
    }
};

const isWeakPin = (pin) => {
    if (/^(\d)\1+$/.test(pin)) return true; // 111111
    const digits = [...pin].map(Number);
    const ascending = digits.every((d, i) => i === 0 || d === (digits[i - 1] + 1) % 10);
    const descending = digits.every((d, i) => i === 0 || d === (digits[i - 1] + 9) % 10);
    return ascending || descending; // 123456, 987654
};

const cleanPin = (value, label = "pin") => {
    const pin = String(value ?? "").trim();
    if (!PIN_RE.test(pin)) throw httpError(400, `${label} must be 4 to 8 digits`);
    if (isWeakPin(pin)) throw httpError(400, `${label} is too easy to guess — avoid repeated or sequential digits`);
    return pin;
};

/**
 * A password the person chooses for themselves: 8–100 characters, at least one
 * letter and one number, and not their email address.
 */
const cleanOwnPassword = (value, email) => {
    if (typeof value !== "string" || value.length < 8) throw httpError(400, "Your new password needs at least 8 characters");
    if (value.length > 100) throw httpError(400, "Your new password can be at most 100 characters");
    if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) throw httpError(400, "Use at least one letter and one number in your new password");
    if (email && value.trim().toLowerCase() === String(email).toLowerCase()) throw httpError(400, "Your password cannot be your email address");
    return value;
};

/** What a user record says about its PIN, for the admin screens and the session payload. */
export const pinStateOf = (user) => ({
    hasPin: Boolean(user.pinHash ?? user.pinSetAt ?? user.pinIsTemporary),
    mustChangePin: Boolean(user.pinIsTemporary),
    pinSetAt: user.pinSetAt ?? null,
});

const ACTIVITY_FIELDS = ["name", "email", "title", "phone", "status", "roles", "referrerId"];

// Model validation failures (email format, unknown roles, weak password) are
// translated into 400s with field details by middleware/errorHandler, so the
// writes below let them propagate.

const USER_INCLUDES = [
    {
        model: BusinessUnit,
        as: "businessUnits",
        attributes: ["id", "code", "name"],
        through: { attributes: [] },
    },
    { model: Referrer, as: "referrer", attributes: ["id", "organisation", "status"] },
];

const normaliseEmail = (email) => {
    if (typeof email !== "string" || !email.trim()) throw httpError(400, "email is required");
    return email.trim().toLowerCase();
};

const normaliseRoles = (roles) => {
    if (!Array.isArray(roles) || roles.length === 0 || roles.some((r) => typeof r !== "string"))
        throw httpError(400, "roles must be a non-empty array of role codes");
    return [...new Set(roles)];
};

// paranoid default scope skips soft-deleted rows, matching the partial unique
// index users_email_active_uq — a deleted user's email is reusable.
const assertEmailAvailable = async (email, excludeUserId = null) => {
    const where = excludeUserId ? { email, id: { [Op.ne]: excludeUserId } } : { email };
    if (await User.findOne({ where, attributes: ["id"] }))
        throw httpError(409, `A user with email "${email}" already exists`);
};

// REF users are external portal logins and must link to their referrer
// organisation; internal users must not carry a referrer link.
const assertReferrerLinkage = async (roles, referrerId) => {
    const isRef = roles.includes("REF");
    if (isRef && !referrerId) throw httpError(400, "REF users require a referrerId (their referrer organisation)");
    if (!isRef && referrerId) throw httpError(400, "referrerId is only valid for users with the REF role");
    if (referrerId && !(await Referrer.findByPk(referrerId)))
        throw httpError(400, `Unknown referrer "${referrerId}"`);
};

const resolveBusinessUnits = async (businessUnitIds) => {
    if (businessUnitIds === undefined) return null; // not provided — leave assignments untouched
    if (!Array.isArray(businessUnitIds))
        throw httpError(400, "businessUnitIds must be an array of business unit ids");
    const unique = [...new Set(businessUnitIds.map((id) => parseId(id, "businessUnitIds entry")))];
    const units = await BusinessUnit.findAll({ where: { id: unique }, attributes: ["id"] });
    if (units.length !== unique.length) {
        const known = new Set(units.map((u) => u.id));
        throw httpError(400, `Unknown business units: ${unique.filter((id) => !known.has(id)).join(", ")}`);
    }
    return unique;
};

// Replace the user's unit assignments with the given set, keeping existing
// rows (and who originally granted them) when the unit stays assigned.
const syncBusinessUnits = async (userId, unitIds, actorId, transaction) => {
    const current = await UserBusinessUnit.findAll({ where: { userId }, transaction });
    const keep = new Set(unitIds);
    const existing = new Set(current.map((link) => link.businessUnitId));

    const toRemove = current.filter((link) => !keep.has(link.businessUnitId)).map((link) => link.id);
    if (toRemove.length) await UserBusinessUnit.destroy({ where: { id: toRemove }, transaction });

    const toAdd = unitIds.filter((id) => !existing.has(id));
    if (toAdd.length)
        await UserBusinessUnit.bulkCreate(
            toAdd.map((businessUnitId) => ({ userId, businessUnitId, assignedById: actorId })),
            { transaction }
        );
};

// Refuses any change that would leave the system without an active
// administrator (companion to the ADM break-glass in roleService).
const assertAnotherActiveAdmin = async (excludeUserId) => {
    const others = await User.count({
        where: {
            id: { [Op.ne]: excludeUserId },
            status: "active",
            roles: { [Op.contains]: [SUPER_ROLE_CODE] },
        },
    });
    if (!others) throw httpError(400, "Cannot remove or disable the last active administrator");
};

const isActiveAdmin = (user) => user.status === "active" && user.roles.includes(SUPER_ROLE_CODE);

// ---------------------------------------------------------------------------
// Actor scoping. Non-ADM user managers (holders of admin.* grants) work on
// users within their own business units only; ADM and internal callers (no
// actor) are unrestricted. null = unrestricted, otherwise the actor's unit ids.

const actorUnitScope = async (actor) => {
    if (!actor || (Array.isArray(actor.roles) && actor.roles.includes(SUPER_ROLE_CODE))) return null;
    const links = await UserBusinessUnit.findAll({
        where: { userId: actor.id },
        attributes: ["businessUnitId"],
    });
    return links.map((link) => link.businessUnitId);
};

const targetUnitIds = (target) => (target.businessUnits ?? []).map((unit) => unit.id);

// A scoped actor may only manage non-administrator users who share at least
// one of the actor's business units.
const assertActorCanManage = (scope, target) => {
    if (!scope) return;
    if (target.roles.includes(SUPER_ROLE_CODE))
        throw httpError(403, "Only administrators can manage administrator accounts");
    if (!targetUnitIds(target).some((id) => scope.includes(id)))
        throw httpError(403, "This user is outside your business units");
};

export const getUser = async (id) => {
    const user = await User.findByPk(parseId(id, "user id"), { include: USER_INCLUDES });
    if (!user) throw httpError(404, "User not found");
    return user;
};

// Session payload (login / me): the user plus their effective permission
// codes, so the frontend gates navigation and screens from data. ADM also
// bypasses checks in code; the frontend mirrors that.
export const getUserWithPermissions = async (id) => {
    const user = await getUser(id);
    const secrets = await User.scope("withPassword").findByPk(user.id, { attributes: ["id", "pinHash", "pinIsTemporary", "pinSetAt"] });
    return {
        ...user.get({ plain: true }),
        ...pinStateOf(secrets ?? user),
        // Signed in with the temporary password an administrator set: their own comes first.
        mustChangePassword: Boolean(user.passwordIsTemporary),
        permissions: await listPermissionCodesForRoles(user.roles),
    };
};

// The requested user, hidden (404) from scoped actors when it is outside
// their business units — reads for GET /users/:id.
export const getUserForActor = async (id, actor) => {
    const user = await getUser(id);
    const scope = await actorUnitScope(actor);
    if (scope && !targetUnitIds(user).some((unitId) => scope.includes(unitId)))
        throw httpError(404, "User not found");
    return user;
};

// Filters: role (code), status, businessUnitId, search (name/email). Paginated.
// Scoped actors only see users assigned to at least one of their units.
export const listUsers = async ({ filters = {}, pagination = {} } = {}, actor = null) => {
    const { role, status, businessUnitId, search } = filters;
    const page = Math.max(1, Number(pagination.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(pagination.pageSize) || 25));

    const where = {};
    if (status) where.status = status;
    if (role) where.roles = { [Op.contains]: [role] };
    if (search) {
        const term = `%${search.trim()}%`;
        where[Op.or] = [{ name: { [Op.iLike]: term } }, { email: { [Op.iLike]: term } }];
    }

    const scope = await actorUnitScope(actor);
    let unitFilter = businessUnitId ? [parseId(businessUnitId, "businessUnitId")] : null;
    if (scope) unitFilter = unitFilter ? unitFilter.filter((id) => scope.includes(id)) : scope;
    if (unitFilter) {
        if (unitFilter.length === 0) return { data: [], total: 0, page, pageSize };
        const links = await UserBusinessUnit.findAll({
            where: { businessUnitId: unitFilter },
            attributes: ["userId"],
        });
        where.id = { [Op.in]: [...new Set(links.map((link) => link.userId))] };
    }

    const { rows, count } = await User.findAndCountAll({
        where,
        include: USER_INCLUDES,
        order: [["name", "ASC"]],
        limit: pageSize,
        offset: (page - 1) * pageSize,
        distinct: true, // count users, not joined rows
    });
    return { data: rows, total: count, page, pageSize };
};

// Minimal people directory for pickers (assign estimator, owner filters,
// names on cards): id, name, title, roles, status and the departments the
// roles put them in — no email, phone or login history. Any signed-in user
// may call it, but only for a business unit they are assigned to (ADM: any
// unit). Active users only. `department` narrows it to one team, the way the
// "assign to another team" form offers people.
export const listDirectory = async ({ businessUnitId, department } = {}, actor = null) => {
    const unitId = parseId(businessUnitId, "businessUnitId");
    const scope = await actorUnitScope(actor);
    if (scope && !scope.includes(unitId)) throw httpError(403, "This business unit is outside your assignments");
    const wanted = department === undefined || department === null || department === "" ? null : String(department);
    if (wanted && !DEPARTMENTS.includes(wanted)) throw httpError(400, `department must be one of: ${DEPARTMENTS.join(", ")}`);

    const links = await UserBusinessUnit.findAll({ where: { businessUnitId: unitId }, attributes: ["userId"] });
    const ids = [...new Set(links.map((link) => link.userId))];
    if (!ids.length) return [];
    const rows = await User.findAll({
        where: { id: { [Op.in]: ids }, status: "active" },
        attributes: ["id", "name", "title", "roles", "status"],
        order: [["name", "ASC"]],
        limit: 500,
    });
    return rows
        .map((row) => ({ ...row.get({ plain: true }), departments: departmentsForRoles(row.roles) }))
        .filter((user) => !wanted || user.departments.includes(wanted));
};

// actor: the administrator or director performing the action (recorded on
// unit assignments). Scoped actors create users only inside their own units
// and can never mint administrator accounts.
//
// Credentials: a password (8+ characters), a temporary PIN (`temporaryPin`,
// 4–8 digits, or `issuePin: true` to have one generated), or both. The
// temporary PIN is returned once, as `temporaryPin` on the result, for the
// administrator to pass on; the person replaces it on first login. A password
// an administrator sets is temporary the same way: the first sign-in with it
// asks the person to choose their own (loginUser → POST /users/me/password).
// Only a user made without an actor (a seed or script) keeps the password given.
export const createUser = async (payload = {}, actor = null, ctx = null) => {
    const actorId = actor?.id ?? null;
    const { name, password, title, phone, status } = payload;
    if (typeof name !== "string" || !name.trim()) throw httpError(400, "name is required");
    const wantsPin = payload.issuePin === true || payload.temporaryPin !== undefined;
    const temporaryPin = wantsPin ? (payload.temporaryPin !== undefined ? cleanPin(payload.temporaryPin, "temporaryPin") : generateTemporaryPin()) : null;
    if (password !== undefined && password !== null && password !== "" && (typeof password !== "string" || password.length < 8))
        throw httpError(400, "password must be at least 8 characters");
    if (!password && !temporaryPin)
        throw httpError(400, "Give the user a password (minimum 8 characters) or a temporary PIN (temporaryPin, or issuePin: true)");
    const email = normaliseEmail(payload.email);
    const roles = normaliseRoles(payload.roles);
    const referrerId = payload.referrerId == null ? null : parseId(payload.referrerId, "referrerId");

    await assertEmailAvailable(email);
    await assertReferrerLinkage(roles, referrerId ?? null);
    const unitIds = (await resolveBusinessUnits(payload.businessUnitIds)) ?? [];

    const scope = await actorUnitScope(actor);
    if (scope) {
        if (roles.includes(SUPER_ROLE_CODE))
            throw httpError(403, "Only administrators can create administrator accounts");
        if (unitIds.length === 0)
            throw httpError(400, "Assign the user to at least one of your business units");
        const outside = unitIds.filter((id) => !scope.includes(id));
        if (outside.length > 0)
            throw httpError(403, "You can only add users to your own business units");
    }

    const user = await sequelize.transaction(async (transaction) => {
        const created = await User.create(
            {
                name: name.trim(),
                email,
                password: password || null, // hashed by the model hook
                passwordIsTemporary: Boolean(password) && Boolean(actor),
                pinHash: temporaryPin ? await hashPin(temporaryPin) : null,
                pinIsTemporary: Boolean(temporaryPin),
                pinIssuedById: temporaryPin ? actorId : null,
                roles,
                title: title ?? null,
                phone: phone ?? null,
                status: status ?? "active",
                referrerId: referrerId ?? null,
            },
            { transaction }
        );
        if (unitIds.length) await syncBusinessUnits(created.id, unitIds, actorId, transaction);
        return created;
    });

    await recordActivity({
        actor, ctx, entityType: "user", entityId: user.id, entityLabel: user.name, action: "created",
        meta: { roles, businessUnitIds: unitIds, credentials: [password ? "password" : null, temporaryPin ? "temporary_pin" : null].filter(Boolean) },
    });
    const fresh = await getUser(user.id);
    return temporaryPin ? Object.assign(fresh, { temporaryPin }) : fresh;
};

// Partial update: name, email, title, phone, status, roles, referrerId,
// businessUnitIds. Password changes go through resetPassword. Scoped actors
// touch only non-admin users who share one of their units, cannot grant ADM,
// and edit unit assignments within their scope — assignments to units outside
// the actor's scope are preserved untouched.
export const updateUser = async (id, payload = {}, actor = null, ctx = null) => {
    const actorId = actor?.id ?? null;
    const user = await getUser(id);
    const before = { ...user.get({ plain: true }), businessUnitIds: targetUnitIds(user) };
    const scope = await actorUnitScope(actor);
    assertActorCanManage(scope, user);
    if (payload.password !== undefined)
        throw httpError(400, "Use the password endpoint to change passwords");

    const updates = {};
    if (payload.name !== undefined) {
        if (typeof payload.name !== "string" || !payload.name.trim())
            throw httpError(400, "name must be a non-empty string");
        updates.name = payload.name.trim();
    }
    if (payload.email !== undefined) {
        updates.email = normaliseEmail(payload.email);
        await assertEmailAvailable(updates.email, user.id);
    }
    if (payload.title !== undefined) updates.title = payload.title ?? null;
    if (payload.phone !== undefined) updates.phone = payload.phone ?? null;
    if (payload.status !== undefined) updates.status = payload.status;
    if (payload.roles !== undefined) updates.roles = normaliseRoles(payload.roles);

    const nextRoles = updates.roles ?? user.roles;
    if (scope && nextRoles.includes(SUPER_ROLE_CODE))
        throw httpError(403, "Only administrators can grant the administrator role");
    const nextReferrerId =
        payload.referrerId === undefined
            ? user.referrerId
            : payload.referrerId == null
              ? null
              : parseId(payload.referrerId, "referrerId");
    await assertReferrerLinkage(nextRoles, nextReferrerId);
    if (payload.referrerId !== undefined) updates.referrerId = nextReferrerId;

    const nextStatus = updates.status ?? user.status;
    const staysActiveAdmin = nextStatus === "active" && nextRoles.includes(SUPER_ROLE_CODE);
    if (isActiveAdmin(user) && !staysActiveAdmin) await assertAnotherActiveAdmin(user.id);

    let unitIds = await resolveBusinessUnits(payload.businessUnitIds);
    if (scope && unitIds !== null) {
        // The actor edits only the in-scope slice; assignments to other
        // units are carried over unchanged (their admins own those).
        const preserved = targetUnitIds(user).filter((unitId) => !scope.includes(unitId));
        const invalid = unitIds.filter((unitId) => !scope.includes(unitId) && !preserved.includes(unitId));
        if (invalid.length > 0)
            throw httpError(403, "You can only assign your own business units");
        unitIds = [...new Set([...preserved, ...unitIds.filter((unitId) => scope.includes(unitId))])];
        if (unitIds.length === 0)
            throw httpError(400, "Keep the user in at least one business unit");
    }

    await sequelize.transaction(async (transaction) => {
        await user.update(updates, { transaction });
        if (unitIds !== null) await syncBusinessUnits(user.id, unitIds, actorId, transaction);
    });

    const fresh = await getUser(id);
    const changes = diff(before, { ...fresh.get({ plain: true }), businessUnitIds: targetUnitIds(fresh) }, [...ACTIVITY_FIELDS, "businessUnitIds"]);
    if (changes) await recordActivity({ actor, ctx, entityType: "user", entityId: fresh.id, entityLabel: fresh.name, action: "updated", changes });
    return fresh;
};

// Admin/director reset. The password set here is temporary: the person signs
// in with it once and must then choose their own (as for a new user) — unless
// administrators are resetting their own, which is theirs already. The
// self-service change is setOwnPassword.
export const resetPassword = async (id, password, actor = null, ctx = null) => {
    if (typeof password !== "string" || password.length < 8)
        throw httpError(400, "password is required (minimum 8 characters)");
    const user = await getUser(id);
    assertActorCanManage(await actorUnitScope(actor), user);
    const own = Boolean(actor) && actor.id === user.id;
    await user.update({ password, passwordIsTemporary: !own, passwordSetAt: own ? new Date() : null }); // hashed by the model hook
    await recordActivity({ actor, ctx, entityType: "user", entityId: user.id, entityLabel: user.name, action: "password_reset", meta: { temporary: !own } });
};

/**
 * The signed-in person sets their own password: { newPassword, currentPassword? }.
 * A temporary password (set by an administrator) is replaced without proof —
 * the sign-in with it was the proof, and the caller holds the set-up token it
 * gave. Changing a password they chose themselves needs the current one.
 * Answers with a full session token.
 */
export const setOwnPassword = async (userId, payload = {}, ctx = null) => {
    const user = await User.scope("withPassword").findByPk(userId);
    if (!user) throw httpError(404, "User not found");
    const newPassword = cleanOwnPassword(payload.newPassword ?? payload.password, user.email);
    const wasTemporary = Boolean(user.passwordIsTemporary);
    if (!wasTemporary) {
        if (typeof payload.currentPassword !== "string" || !(await user.checkPassword(payload.currentPassword)))
            throw httpError(400, "Enter your current password to change it");
    }
    if (await user.checkPassword(newPassword))
        throw httpError(400, wasTemporary ? "Choose a new password — not the temporary one you were given" : "Choose a password different from the current one");
    await user.update({ password: newPassword, passwordIsTemporary: false, passwordSetAt: new Date() }); // hashed by the model hook
    await recordActivity({
        actor: user, ctx, entityType: "user", entityId: user.id, entityLabel: user.name,
        action: wasTemporary ? "password_set_first_login" : "password_changed",
    });
    return { token: signToken(user), user: await getUserWithPermissions(user.id) };
};

/**
 * An administrator issues a new temporary PIN ({ temporaryPin? } — generated
 * when not given). Returned once; the person must replace it on first login.
 */
export const resetPin = async (id, payload = {}, actor = null, ctx = null) => {
    const user = await getUser(id);
    assertActorCanManage(await actorUnitScope(actor), user);
    const temporaryPin = payload.temporaryPin !== undefined ? cleanPin(payload.temporaryPin, "temporaryPin") : generateTemporaryPin();
    await user.update({ pinHash: await hashPin(temporaryPin), pinIsTemporary: true, pinSetAt: null, pinIssuedById: actor?.id ?? null });
    await recordActivity({ actor, ctx, entityType: "user", entityId: user.id, entityLabel: user.name, action: "pin_reset" });
    return { temporaryPin, user: await getUser(user.id) };
};

/** An administrator removes a user's PIN, so they sign in with their password only. */
export const clearPin = async (id, actor = null, ctx = null) => {
    const user = await getUser(id);
    assertActorCanManage(await actorUnitScope(actor), user);
    const secrets = await User.scope("withPassword").findByPk(user.id, { attributes: ["id", "password"] });
    if (!secrets?.password) throw httpError(400, "This user has no password — issue a new PIN instead of removing the only way in");
    await user.update({ pinHash: null, pinIsTemporary: false, pinSetAt: null, pinIssuedById: null });
    await recordActivity({ actor, ctx, entityType: "user", entityId: user.id, entityLabel: user.name, action: "pin_removed" });
};

/**
 * The signed-in person sets their own PIN: { pin, currentPin? , currentPassword? }.
 * A temporary PIN is replaced without proof (the login with it was the
 * proof); replacing a PIN they already chose, or adding one beside a
 * password, needs the current PIN or the password. Answers with a full
 * session token, since the caller may be holding only the set-up token.
 */
export const setOwnPin = async (userId, payload = {}, ctx = null) => {
    const user = await User.scope("withPassword").findByPk(userId);
    if (!user) throw httpError(404, "User not found");
    const pin = cleanPin(payload.pin, "pin");
    if (!user.pinIsTemporary) {
        const proved =
            (payload.currentPin !== undefined && (await user.checkPin(payload.currentPin))) ||
            (payload.currentPassword !== undefined && (await user.checkPassword(payload.currentPassword)));
        if (!proved) throw httpError(400, user.pinHash ? "Enter your current PIN (or password) to change it" : "Enter your password to set a PIN");
    }
    if (user.pinHash && (await user.checkPin(pin))) throw httpError(400, "Choose a PIN different from the current one");
    const wasTemporary = user.pinIsTemporary;
    await user.update({ pinHash: await hashPin(pin), pinIsTemporary: false, pinSetAt: new Date() });
    await recordActivity({
        actor: user, ctx, entityType: "user", entityId: user.id, entityLabel: user.name,
        action: wasTemporary ? "pin_set_first_login" : "pin_changed",
    });
    return { token: signToken(user), user: await getUserWithPermissions(user.id) };
};

export const deleteUser = async (id, actor = null, ctx = null) => {
    const user = await getUser(id);
    assertActorCanManage(await actorUnitScope(actor), user);
    if (isActiveAdmin(user)) await assertAnotherActiveAdmin(user.id);
    await user.destroy(); // soft delete; unit assignments stay for the audit trail
    await recordActivity({ actor, ctx, entityType: "user", entityId: user.id, entityLabel: user.name, action: "deleted" });
};

// Login for staff and referrer-portal users. Issues a JWT carrying the user
// id; every request re-validates the user via the tokenValidator middleware.
//
// { email, password } as always, or { email, pin }. A login with a temporary
// PIN answers with mustChangePin: true and a token that only opens
// GET /users/me and POST /users/me/pin — the person sets their own PIN there
// and gets a full session token back. A login with a temporary password (one
// an administrator set) does the same: mustChangePassword: true and a token
// that only opens GET /users/me and POST /users/me/password.
export const loginUser = async ({ email, password, pin } = {}, ctx = null) => {
    if (typeof email !== "string" || !email.trim()) throw httpError(400, "email is required");
    const withPin = pin !== undefined && pin !== null && pin !== "";
    if (!withPin && (typeof password !== "string" || !password)) throw httpError(400, "password or pin is required");

    const user = await User.scope("withPassword").findOne({
        where: { email: email.trim().toLowerCase() },
    });
    // Same message for unknown email and wrong credential — no account probing
    const ok = user && (withPin ? await user.checkPin(pin) : await user.checkPassword(password));
    if (!ok) throw httpError(401, withPin ? "Invalid email or PIN" : "Invalid email or password");
    if (user.status !== "active") throw httpError(401, "Account is disabled");

    await user.update({ lastLoginAt: new Date() });
    const mustChangePin = withPin && Boolean(user.pinIsTemporary);
    const mustChangePassword = !withPin && Boolean(user.passwordIsTemporary);
    await recordActivity({
        actor: user, ctx, entityType: "user", entityId: user.id, entityLabel: user.name,
        action: "login",
        meta: { method: withPin ? "pin" : "password", ...(mustChangePin ? { temporaryPin: true } : {}), ...(mustChangePassword ? { temporaryPassword: true } : {}) },
    });

    return {
        token: mustChangePin ? signPinSetupToken(user) : mustChangePassword ? signPasswordSetupToken(user) : signToken(user),
        user: await getUserWithPermissions(user.id),
        mustChangePin,
        mustChangePassword,
    };
};
