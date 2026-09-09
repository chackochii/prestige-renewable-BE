// User management. Required info to create a user: name, email, password and
// at least one role; optionally title, phone, status, business unit
// assignments (deny-by-default access — a user only works in units listed for
// them) and, for REF users, the referrer organisation their portal login
// belongs to. Role codes are validated against the roles table by the model,
// so roles created at runtime are immediately assignable.
import { Op } from "sequelize";
import db from "../../../models/index.js";
import { SUPER_ROLE_CODE, listPermissionCodesForRoles } from "../../role/service/roleService.js";
import { parseId } from "../../../utils/ids.js";
import { signToken } from "../../../utils/jwt.js";

const { User, BusinessUnit, UserBusinessUnit, Referrer, sequelize } = db;

const httpError = (status, message) => Object.assign(new Error(message), { status });

// Model validation failures (email format, unknown roles, weak password) are
// client errors, not server faults — surface them as 400s with field details.
const asHttpError = (err) => {
    if (err.name === "SequelizeValidationError" || err.name === "SequelizeUniqueConstraintError") {
        const errors = err.errors?.map((e) => ({ field: e.path, message: e.message })) ?? null;
        return Object.assign(httpError(400, errors?.[0]?.message ?? "Validation failed"), { errors });
    }
    return err;
};

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
    return {
        ...user.get({ plain: true }),
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
// names on cards): id, name, title, roles and status only — no email, phone
// or login history. Any signed-in user may call it, but only for a business
// unit they are assigned to (ADM: any unit). Active users only.
export const listDirectory = async ({ businessUnitId } = {}, actor = null) => {
    const unitId = parseId(businessUnitId, "businessUnitId");
    const scope = await actorUnitScope(actor);
    if (scope && !scope.includes(unitId)) throw httpError(403, "This business unit is outside your assignments");

    const links = await UserBusinessUnit.findAll({ where: { businessUnitId: unitId }, attributes: ["userId"] });
    const ids = [...new Set(links.map((link) => link.userId))];
    if (!ids.length) return [];
    return User.findAll({
        where: { id: { [Op.in]: ids }, status: "active" },
        attributes: ["id", "name", "title", "roles", "status"],
        order: [["name", "ASC"]],
        limit: 500,
    });
};

// actor: the administrator or director performing the action (recorded on
// unit assignments). Scoped actors create users only inside their own units
// and can never mint administrator accounts.
export const createUser = async (payload = {}, actor = null) => {
    const actorId = actor?.id ?? null;
    const { name, password, title, phone, status } = payload;
    if (typeof name !== "string" || !name.trim()) throw httpError(400, "name is required");
    if (typeof password !== "string" || password.length < 8)
        throw httpError(400, "password is required (minimum 8 characters)");
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
        try {
            const created = await User.create(
                {
                    name: name.trim(),
                    email,
                    password, // hashed by the model hook
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
        } catch (err) {
            throw asHttpError(err);
        }
    });

    return getUser(user.id);
};

// Partial update: name, email, title, phone, status, roles, referrerId,
// businessUnitIds. Password changes go through resetPassword. Scoped actors
// touch only non-admin users who share one of their units, cannot grant ADM,
// and edit unit assignments within their scope — assignments to units outside
// the actor's scope are preserved untouched.
export const updateUser = async (id, payload = {}, actor = null) => {
    const actorId = actor?.id ?? null;
    const user = await getUser(id);
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
        try {
            await user.update(updates, { transaction });
            if (unitIds !== null) await syncBusinessUnits(user.id, unitIds, actorId, transaction);
        } catch (err) {
            throw asHttpError(err);
        }
    });

    return getUser(id);
};

// Admin/director reset. Self-service change (with current-password check)
// arrives with the auth module.
export const resetPassword = async (id, password, actor = null) => {
    if (typeof password !== "string" || password.length < 8)
        throw httpError(400, "password is required (minimum 8 characters)");
    const user = await getUser(id);
    assertActorCanManage(await actorUnitScope(actor), user);
    try {
        await user.update({ password }); // hashed by the model hook
    } catch (err) {
        throw asHttpError(err);
    }
};

export const deleteUser = async (id, actor = null) => {
    const user = await getUser(id);
    assertActorCanManage(await actorUnitScope(actor), user);
    if (isActiveAdmin(user)) await assertAnotherActiveAdmin(user.id);
    await user.destroy(); // soft delete; unit assignments stay for the audit trail
};

// Login for staff and referrer-portal users. Issues a JWT carrying the user
// id; every request re-validates the user via the tokenValidator middleware.
export const loginUser = async ({ email, password } = {}) => {
    if (typeof email !== "string" || !email.trim()) throw httpError(400, "email is required");
    if (typeof password !== "string" || !password) throw httpError(400, "password is required");

    const user = await User.scope("withPassword").findOne({
        where: { email: email.trim().toLowerCase() },
    });
    // Same message for unknown email and wrong password — no account probing
    if (!user || !(await user.checkPassword(password)))
        throw httpError(401, "Invalid email or password");
    if (user.status !== "active") throw httpError(401, "Account is disabled");

    await user.update({ lastLoginAt: new Date() });

    return { token: signToken(user), user: await getUserWithPermissions(user.id) };
};
