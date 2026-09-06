"use strict";

// Seeds the page registry (app_pages), the per-page view permissions, and the
// default role → page grants that mirror the sidebar the frontend previously
// hardcoded. After this runs, "which roles see which pages" is data edited on
// the roles screen, and "which pages a business unit runs" is data edited on
// the pages screen — neither is code.
//
// Idempotent by design, matching roles-permissions.cjs: page and permission
// rows are upserted (display fields converge), while default grants are only
// inserted for a page permission that currently has NO grants at all — so
// re-running never clobbers grant edits made at runtime.
//
// Runs after roles-permissions.cjs under db:seed:all (seeders execute in
// filename order) — the default grants need the role rows to exist.

// [code, label, path, sortOrder, viewPermissionCode|null]
// null viewPermissionCode = visible to every authenticated user.
const PAGES = [
    ["leads", "Leads", "/leads", 5, "page.leads.view"],
    ["pipeline", "Pipeline", "/pipeline", 10, "page.pipeline.view"],
    ["marketing", "Marketing", "/marketing", 20, "page.marketing.view"],
    ["approvals", "Approvals", "/approvals", 30, "page.approvals.view"],
    ["procurement", "Procurement", "/procurement", 40, "page.procurement.view"],
    ["construction", "Construction", "/construction", 45, "page.construction.view"],
    ["quotes", "Quotes", "/quotes", 50, "page.quotes.view"],
    ["costs", "Costs", "/costs", 60, "page.costs.view"],
    ["billing", "Financials", "/billing", 70, "page.billing.view"],
    ["warranty", "Warranty", "/warranty", 75, "page.warranty.view"],
    ["referrers", "Referrers", "/referrers", 80, "page.referrers.view"],
    ["dashboards", "Dashboards", "/dashboards", 85, "page.dashboards.view"],
    ["admin", "Admin", "/admin", 90, "page.admin.view"],
];

// Default role grants per page permission — a page is granted to every role
// with read access in the matching matrix module (Sydpro RACI, Sep 2026).
// ADM is not listed: it bypasses permission checks in code.
const GRANTS = {
    "page.leads.view": ["BO", "SMM", "SREP", "DEST", "BOM", "OPC", "FIN"],
    "page.pipeline.view": ["BO", "SMM", "SREP", "DEST", "BOM", "OPC", "FIN"],
    "page.marketing.view": ["BO", "SMM"],
    "page.approvals.view": ["BO", "SMM", "SREP", "DEST", "BOM", "OPC", "PROC", "FIN"],
    "page.procurement.view": ["BO", "SMM", "SREP", "DEST", "BOM", "OPC", "SITEOM", "CREW", "PROC", "FIN"],
    "page.construction.view": ["BO", "SMM", "SREP", "DEST", "BOM", "OPC", "SITEOM", "CREW", "PROC", "QSM", "OMM"],
    "page.quotes.view": ["BO", "SMM", "SREP", "DEST", "BOM", "OPC", "PROC", "FIN"],
    "page.costs.view": ["BO", "SMM", "DEST", "BOM", "OPC", "PROC", "FIN"],
    "page.billing.view": ["BO", "SMM", "SREP", "BOM", "OPC", "PROC", "FIN"],
    "page.warranty.view": ["BO", "SMM", "SREP", "BOM", "OPC", "SITEOM", "CREW", "FIN", "QSM", "OMM"],
    "page.referrers.view": ["BO", "SMM", "SREP"],
    "page.dashboards.view": ["BO", "SMM", "SREP", "DEST", "BOM", "OPC", "SITEOM", "PROC", "FIN", "QSM", "OMM", "SYS"],
    "page.admin.view": ["BO", "SMM", "SYS"], // read access; management stays permission-gated in the pages themselves
};

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface) {
        const { sequelize } = queryInterface;

        // 1. Upsert the per-page view permissions into the RBAC catalog.
        for (const [, label, , , permission] of PAGES) {
            if (!permission) continue;
            await sequelize.query(
                `INSERT INTO permissions (code, name, category, is_system, created_at, updated_at)
                 VALUES (:code, :name, 'Pages', true, NOW(), NOW())
                 ON CONFLICT (code) DO UPDATE
                 SET name = EXCLUDED.name, category = 'Pages', is_system = true, updated_at = NOW()`,
                { replacements: { code: permission, name: `View ${label}` } }
            );
        }

        // 2. Upsert the page registry.
        for (const [code, label, path, sortOrder, permission] of PAGES) {
            await sequelize.query(
                `INSERT INTO app_pages (code, label, path, sort_order, view_permission_code, is_system, created_at, updated_at)
                 VALUES (:code, :label, :path, :sortOrder, :permission, true, NOW(), NOW())
                 ON CONFLICT (code) DO UPDATE
                 SET label = EXCLUDED.label, path = EXCLUDED.path, sort_order = EXCLUDED.sort_order,
                     view_permission_code = EXCLUDED.view_permission_code, is_system = true, updated_at = NOW()`,
                { replacements: { code, label, path, sortOrder, permission } }
            );
        }

        // 3. Default grants — only where the page permission has no grants yet,
        //    so runtime edits on the roles screen survive re-seeding.
        const [roleRows] = await sequelize.query("SELECT id, code FROM roles");
        const [permRows] = await sequelize.query(
            "SELECT id, code FROM permissions WHERE category = 'Pages'"
        );
        const [grantedRows] = await sequelize.query(
            `SELECT DISTINCT permission_id FROM role_permissions
             WHERE permission_id IN (SELECT id FROM permissions WHERE category = 'Pages')`
        );
        const roleId = Object.fromEntries(roleRows.map((r) => [r.code, r.id]));
        const permId = Object.fromEntries(permRows.map((p) => [p.code, p.id]));
        const alreadyGranted = new Set(grantedRows.map((r) => r.permission_id));

        const now = new Date();
        const rows = [];
        for (const [permission, roles] of Object.entries(GRANTS)) {
            if (!permId[permission] || alreadyGranted.has(permId[permission])) continue;
            for (const role of roles) {
                if (!roleId[role]) continue; // role not seeded (e.g. future DIRBD)
                rows.push({
                    role_id: roleId[role],
                    permission_id: permId[permission],
                    created_at: now,
                    updated_at: now,
                });
            }
        }
        if (rows.length) await queryInterface.bulkInsert("role_permissions", rows);
    },

    async down(queryInterface) {
        // Removes only rows this seeder owns; unit overrides and grants cascade.
        await queryInterface.bulkDelete("app_pages", { code: PAGES.map(([code]) => code) });
        await queryInterface.bulkDelete("permissions", {
            code: PAGES.map(([, , , , permission]) => permission).filter(Boolean),
        });
    },
};
