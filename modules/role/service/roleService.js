// Runtime-editable RBAC. Roles, permissions and role → permission grants all
// live in the database; users carry role codes (users.roles) which this
// service resolves to permission codes via roles/permissions/role_permissions.
//
// Phase 1 treats the seeded catalog as fixed, but this service already covers
// full runtime management — create/rename/retire roles, single-parent
// inheritance, custom permissions — so making the catalog user-editable later
// is only a matter of exposing routes, not a redesign. The one thing kept in
// code is the ADM break-glass below.
import { Op } from "sequelize";
import db from "../../../models/index.js";

const { Role, Permission, RolePermission, User, sequelize } = db;

const httpError = (status, message) => Object.assign(new Error(message), { status });

// Break-glass, deliberately code not data: ADM passes every permission check,
// so no grant edit can ever lock administrators out of the permission editor.
export const SUPER_ROLE_CODE = "ADM";

const ROLE_CODE_RE = /^[A-Z][A-Z0-9_]{1,19}$/; // e.g. "BDM", "DIRBD"
const PERM_CODE_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/; // e.g. "pricing.edit"

// role code → Set of permission codes, cached so permission checks don't hit
// the database on every request. Invalidated on catalog/grant changes in this
// process; the TTL covers changes made by other instances.
const CACHE_TTL_MS = 30_000;
let cache = { at: 0, byRole: null };

export const invalidateGrantCache = () => {
    cache = { at: 0, byRole: null };
};

const rolesWithPermissions = () =>
    Role.findAll({
        include: [{ model: Permission, as: "permissions", through: { attributes: [] } }],
        order: [["code", "ASC"], [{ model: Permission, as: "permissions" }, "code", "ASC"]],
    });

// role.id → Set of effective permission codes: the role's own grants unioned
// with everything its inheritsFromRoleId ancestor chain grants. Memoising the
// set before recursing makes an (invalid, write-time-rejected) cycle terminate
// instead of overflowing.
const resolveGrants = (roles) => {
    const byId = new Map(roles.map((r) => [r.id, r]));
    const resolved = new Map();
    const resolve = (role) => {
        if (resolved.has(role.id)) return resolved.get(role.id);
        const set = new Set(role.permissions.map((p) => p.code));
        resolved.set(role.id, set);
        const parent = role.inheritsFromRoleId ? byId.get(role.inheritsFromRoleId) : null;
        if (parent) for (const code of resolve(parent)) set.add(code);
        return set;
    };
    roles.forEach(resolve);
    return resolved;
};

const getGrants = async () => {
    if (!cache.byRole || Date.now() - cache.at > CACHE_TTL_MS) {
        const roles = await rolesWithPermissions();
        const resolved = resolveGrants(roles);
        // Inactive roles grant nothing to their holders (they still contribute
        // grants to descendants that inherit from them).
        const byRole = new Map(roles.filter((r) => r.isActive).map((r) => [r.code, resolved.get(r.id)]));
        cache = { at: Date.now(), byRole };
    }
    return cache.byRole;
};

export const userHasPermission = async (user, permissionCode) => {
    const roleCodes = Array.isArray(user?.roles) ? user.roles : [];
    if (roleCodes.includes(SUPER_ROLE_CODE)) return true;
    const byRole = await getGrants();
    return roleCodes.some((code) => byRole.get(code)?.has(permissionCode));
};

// Effective permission codes for a set of role codes — embedded in the
// login/me payload so the frontend gates navigation and screens from data.
// ADM holders get whatever is granted plus the code-level bypass; the
// frontend mirrors that by treating ADM as all-access.
export const listPermissionCodesForRoles = async (roleCodes = []) => {
    const byRole = await getGrants();
    const codes = new Set();
    for (const role of roleCodes) for (const code of byRole.get(role) ?? []) codes.add(code);
    return [...codes].sort();
};

// ---------------------------------------------------------------------------
// Catalog reads

export const listRoles = async () => {
    const roles = await rolesWithPermissions();
    const resolved = resolveGrants(roles);
    const codeById = new Map(roles.map((r) => [r.id, r.code]));
    return roles.map((role) => ({
        ...role.get({ plain: true }),
        inheritsFrom: role.inheritsFromRoleId ? codeById.get(role.inheritsFromRoleId) : null,
        effectivePermissions: [...resolved.get(role.id)].sort(), // own + inherited
    }));
};

export const listPermissions = () =>
    Permission.findAll({ order: [["category", "ASC"], ["code", "ASC"]] });

const getRoleView = async (code) => (await listRoles()).find((r) => r.code === code);

const findRoleByCode = async (code) => {
    const role = await Role.findOne({ where: { code } });
    if (!role) throw httpError(404, `Unknown role "${code}"`);
    return role;
};

// ---------------------------------------------------------------------------
// Grants

const resolvePermissionCodes = async (permissionCodes) => {
    if (!Array.isArray(permissionCodes) || permissionCodes.some((c) => typeof c !== "string"))
        throw httpError(400, "permissionCodes must be an array of permission code strings");
    const unique = [...new Set(permissionCodes)];
    const permissions = await Permission.findAll({ where: { code: unique } });
    if (permissions.length !== unique.length) {
        const known = new Set(permissions.map((p) => p.code));
        throw httpError(400, `Unknown permissions: ${unique.filter((c) => !known.has(c)).join(", ")}`);
    }
    return permissions;
};

// Replaces the role's own grant set wholesale — the payload is the full list
// of permission codes the role should hold directly (inherited ones excluded).
export const setRolePermissions = async (roleCode, permissionCodes) => {
    const role = await findRoleByCode(roleCode);
    const permissions = await resolvePermissionCodes(permissionCodes);

    await sequelize.transaction(async (transaction) => {
        await RolePermission.destroy({ where: { roleId: role.id }, transaction });
        await RolePermission.bulkCreate(
            permissions.map((p) => ({ roleId: role.id, permissionId: p.id })),
            { transaction }
        );
    });
    invalidateGrantCache();

    return getRoleView(roleCode);
};

// ---------------------------------------------------------------------------
// Role management (future dynamic phase — endpoints exist, UI comes later)

// Rejects an inheritsFrom assignment whose ancestor chain leads back to the
// role itself.
const assertNoInheritanceCycle = async (role, parent) => {
    for (let current = parent; current; ) {
        if (current.id === role.id)
            throw httpError(400, `"${role.code}" cannot inherit from "${parent.code}" — that would create a cycle`);
        current = current.inheritsFromRoleId ? await Role.findByPk(current.inheritsFromRoleId) : null;
    }
};

export const createRole = async ({ code, name, description, inheritsFrom, permissionCodes } = {}) => {
    if (typeof code !== "string" || !ROLE_CODE_RE.test(code))
        throw httpError(400, "code must be 2–20 chars of A–Z, 0–9 or _, starting with a letter");
    if (typeof name !== "string" || !name.trim()) throw httpError(400, "name is required");
    if (await Role.findOne({ where: { code } })) throw httpError(409, `Role "${code}" already exists`);

    const parent = inheritsFrom ? await findRoleByCode(inheritsFrom) : null;
    await Role.create({
        code,
        name: name.trim(),
        description: description ?? null,
        inheritsFromRoleId: parent?.id ?? null,
    });
    if (permissionCodes !== undefined) await setRolePermissions(code, permissionCodes);
    invalidateGrantCache();

    return getRoleView(code);
};

// Codes are immutable (they live in users.roles arrays and workflow config);
// everything else about a role can change.
export const updateRole = async (roleCode, { code, name, description, isActive, inheritsFrom } = {}) => {
    const role = await findRoleByCode(roleCode);
    if (code !== undefined && code !== role.code) throw httpError(400, "Role codes are immutable");

    if (name !== undefined) {
        if (typeof name !== "string" || !name.trim()) throw httpError(400, "name must be a non-empty string");
        role.name = name.trim();
    }
    if (description !== undefined) role.description = description ?? null;
    if (isActive !== undefined) {
        if (role.code === SUPER_ROLE_CODE && !isActive)
            throw httpError(400, `"${SUPER_ROLE_CODE}" cannot be deactivated`);
        role.isActive = Boolean(isActive);
    }
    if (inheritsFrom !== undefined) {
        if (inheritsFrom === null) {
            role.inheritsFromRoleId = null;
        } else {
            const parent = await findRoleByCode(inheritsFrom);
            await assertNoInheritanceCycle(role, parent);
            role.inheritsFromRoleId = parent.id;
        }
    }

    await role.save();
    invalidateGrantCache();

    return getRoleView(role.code);
};

export const deleteRole = async (roleCode) => {
    const role = await findRoleByCode(roleCode);
    if (role.isSystem)
        throw httpError(400, `"${roleCode}" is a system role and cannot be deleted — deactivate it instead`);

    const holders = await User.count({ where: { roles: { [Op.contains]: [roleCode] } } });
    if (holders > 0)
        throw httpError(409, `Role "${roleCode}" is assigned to ${holders} user(s) — reassign them or deactivate the role`);

    await role.destroy(); // role_permissions rows cascade
    invalidateGrantCache();
};

// ---------------------------------------------------------------------------
// Permission catalog management (future dynamic phase)

const findPermissionByCode = async (code) => {
    const permission = await Permission.findOne({ where: { code } });
    if (!permission) throw httpError(404, `Unknown permission "${code}"`);
    return permission;
};

export const createPermission = async ({ code, name, category } = {}) => {
    if (typeof code !== "string" || code.length > 50 || !PERM_CODE_RE.test(code))
        throw httpError(400, 'code must look like "area.action" (lowercase, dot-separated, max 50 chars)');
    if (typeof name !== "string" || !name.trim()) throw httpError(400, "name is required");
    if (await Permission.findOne({ where: { code } })) throw httpError(409, `Permission "${code}" already exists`);

    return Permission.create({ code, name: name.trim(), category: category ?? null });
};

// Display metadata only — codes are immutable because route guards reference them.
export const updatePermission = async (permCode, { code, name, category } = {}) => {
    const permission = await findPermissionByCode(permCode);
    if (code !== undefined && code !== permission.code) throw httpError(400, "Permission codes are immutable");

    if (name !== undefined) {
        if (typeof name !== "string" || !name.trim()) throw httpError(400, "name must be a non-empty string");
        permission.name = name.trim();
    }
    if (category !== undefined) permission.category = category ?? null;

    return permission.save();
};

export const deletePermission = async (permCode) => {
    const permission = await findPermissionByCode(permCode);
    if (permission.isSystem)
        throw httpError(400, `"${permCode}" is a system permission enforced in application code and cannot be deleted`);

    await permission.destroy(); // role_permissions rows cascade
    invalidateGrantCache();
};
