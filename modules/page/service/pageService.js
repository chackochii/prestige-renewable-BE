// Page registry + per-unit enablement. The sidebar is data: pages live in
// app_pages, role visibility rides the permission catalog (viewPermissionCode)
// and per-unit on/off state lives in business_unit_pages. No row for a
// (unit, page) pair means enabled — new pages default on everywhere.
import db from "../../../models/index.js";
import { SUPER_ROLE_CODE } from "../../role/service/roleService.js";
import { parseId } from "../../../utils/ids.js";

const { AppPage, BusinessUnitPage, BusinessUnit, Permission, sequelize } = db;

const httpError = (status, message) => Object.assign(new Error(message), { status });

const PAGE_CODE_RE = /^[a-z][a-z0-9_-]{1,29}$/; // e.g. "pipeline"

// Turning the admin page off for a unit hides the screen used to turn it back
// on, so only the superadmin (ADM) may disable it — delegated managers with
// business_unit.manage cannot.
const SUPERADMIN_ONLY_PAGE_CODES = new Set(["admin"]);
const PATH_RE = /^\/[a-z0-9\-/]*$/; // e.g. "/pipeline"

export const listPages = () =>
    AppPage.findAll({ order: [["sortOrder", "ASC"], ["code", "ASC"]] });

const findPageByCode = async (code) => {
    const page = await AppPage.findOne({ where: { code } });
    if (!page) throw httpError(404, `Unknown page "${code}"`);
    return page;
};

const assertViewPermissionExists = async (code) => {
    if (code === null) return;
    if (typeof code !== "string" || !code.trim())
        throw httpError(400, "viewPermissionCode must be a permission code or null");
    if (!(await Permission.findOne({ where: { code } })))
        throw httpError(400, `Unknown permission "${code}" — create it in the permission catalog first`);
};

export const createPage = async ({ code, label, path, sortOrder, viewPermissionCode } = {}) => {
    if (typeof code !== "string" || !PAGE_CODE_RE.test(code))
        throw httpError(400, "code must be 2–30 chars of a–z, 0–9, - or _, starting with a letter");
    if (typeof label !== "string" || !label.trim()) throw httpError(400, "label is required");
    if (typeof path !== "string" || !PATH_RE.test(path))
        throw httpError(400, 'path must look like "/pipeline"');
    if (await AppPage.findOne({ where: { code } })) throw httpError(409, `Page "${code}" already exists`);
    await assertViewPermissionExists(viewPermissionCode ?? null);

    return AppPage.create({
        code,
        label: label.trim(),
        path,
        sortOrder: Number.isFinite(Number(sortOrder)) ? Number(sortOrder) : 0,
        viewPermissionCode: viewPermissionCode ?? null,
    });
};

// Codes are immutable (unit overrides and the frontend router key off them);
// display fields, ordering and the guarding permission can change.
export const updatePage = async (pageCode, { code, label, path, sortOrder, viewPermissionCode } = {}) => {
    const page = await findPageByCode(pageCode);
    if (code !== undefined && code !== page.code) throw httpError(400, "Page codes are immutable");

    if (label !== undefined) {
        if (typeof label !== "string" || !label.trim()) throw httpError(400, "label must be a non-empty string");
        page.label = label.trim();
    }
    if (path !== undefined) {
        if (page.isSystem && path !== page.path)
            throw httpError(400, `"${pageCode}" is a system page — its route is defined in the frontend and cannot move`);
        if (typeof path !== "string" || !PATH_RE.test(path)) throw httpError(400, 'path must look like "/pipeline"');
        page.path = path;
    }
    if (sortOrder !== undefined) {
        if (!Number.isFinite(Number(sortOrder))) throw httpError(400, "sortOrder must be a number");
        page.sortOrder = Number(sortOrder);
    }
    if (viewPermissionCode !== undefined) {
        await assertViewPermissionExists(viewPermissionCode);
        page.viewPermissionCode = viewPermissionCode;
    }

    return page.save();
};

export const deletePage = async (pageCode) => {
    const page = await findPageByCode(pageCode);
    if (page.isSystem)
        throw httpError(400, `"${pageCode}" is a system page backed by a frontend route and cannot be deleted`);
    await page.destroy(); // business_unit_pages rows cascade
};

// ---------------------------------------------------------------------------
// Per-unit enablement

const findUnit = async (id) => {
    const unit = await BusinessUnit.findByPk(parseId(id, "business unit id"));
    if (!unit) throw httpError(404, "Business unit not found");
    return unit;
};

// Every page with its effective enabled flag for one unit.
export const getUnitPages = async (businessUnitId) => {
    const unit = await findUnit(businessUnitId);
    const [pages, overrides] = await Promise.all([
        listPages(),
        BusinessUnitPage.findAll({ where: { businessUnitId: unit.id } }),
    ]);
    const overrideByPage = new Map(overrides.map((o) => [o.pageId, o.enabled]));
    return {
        id: unit.id,
        code: unit.code,
        name: unit.name,
        pages: pages.map((page) => ({
            code: page.code,
            label: page.label,
            path: page.path,
            sortOrder: page.sortOrder,
            viewPermissionCode: page.viewPermissionCode,
            enabled: overrideByPage.get(page.id) ?? true,
        })),
    };
};

// Replace the unit's toggles: payload is [{ code, enabled }]. Pages not
// mentioned keep their current state.
export const setUnitPages = async (businessUnitId, entries, actor) => {
    const unit = await findUnit(businessUnitId);
    if (!Array.isArray(entries) || entries.length === 0)
        throw httpError(400, "pages must be a non-empty array of { code, enabled }");

    const codes = entries.map((e) => e?.code);
    if (codes.some((c) => typeof c !== "string"))
        throw httpError(400, "Each entry needs a page code string");
    if (new Set(codes).size !== codes.length) throw httpError(400, "Duplicate page codes in payload");
    const actorIsSuperAdmin =
        Array.isArray(actor?.roles) && actor.roles.includes(SUPER_ROLE_CODE);
    for (const entry of entries) {
        if (SUPERADMIN_ONLY_PAGE_CODES.has(entry.code) && !entry.enabled && !actorIsSuperAdmin)
            throw httpError(403, `Only the system administrator can turn off the "${entry.code}" page`);
    }

    const pages = await AppPage.findAll({ where: { code: codes } });
    if (pages.length !== codes.length) {
        const known = new Set(pages.map((p) => p.code));
        throw httpError(400, `Unknown pages: ${codes.filter((c) => !known.has(c)).join(", ")}`);
    }
    const pageByCode = new Map(pages.map((p) => [p.code, p]));

    await sequelize.transaction(async (transaction) => {
        for (const entry of entries) {
            const page = pageByCode.get(entry.code);
            const [override] = await BusinessUnitPage.findOrCreate({
                where: { businessUnitId: unit.id, pageId: page.id },
                defaults: { enabled: Boolean(entry.enabled) },
                transaction,
            });
            if (override.enabled !== Boolean(entry.enabled))
                await override.update({ enabled: Boolean(entry.enabled) }, { transaction });
        }
    });

    return getUnitPages(unit.id);
};

// unitId → [disabled page codes], for embedding in business-unit lists so the
// sidebar can filter without an extra request per unit.
export const disabledPageCodesByUnit = async () => {
    const overrides = await BusinessUnitPage.findAll({
        where: { enabled: false },
        include: [{ model: AppPage, as: "page", attributes: ["code"] }],
    });
    const byUnit = new Map();
    for (const override of overrides) {
        if (!byUnit.has(override.businessUnitId)) byUnit.set(override.businessUnitId, []);
        byUnit.get(override.businessUnitId).push(override.page.code);
    }
    return byUnit;
};
