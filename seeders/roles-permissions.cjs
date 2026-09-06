"use strict";

// Syncs the system RBAC catalog with the fourteen business roles from the
// Sydpro role/permission matrix (RACI review, Sep 2026) plus ADM — system
// infrastructure for the superadmin login and the permission-check
// break-glass, not a business role.
//
// The permission catalog is module.action: nine modules (matrix columns) ×
// five actions (C/R/U/D/A → create/read/update/delete/approve), plus two
// scoped codes for Installation Crew (checklists) and Quality & Safety (HSE).
//
// Idempotent by design: inserts missing rows, refreshes system rows' display
// fields, retires roles and permissions no longer in the catalog, and seeds
// DEFAULT grants only for roles that currently hold none — so re-running it
// never clobbers grant edits made at runtime via PUT /api/roles/:code/permissions.
//
// Sydpro workflow rules that grants alone cannot express live in
// modules/opportunity/service/approvalPolicy.js (variation 5% escalation,
// purchase-order self-approval block) — endpoints must call that policy.

// [code, name, description]
const ROLES = [
    ["BO", "Business Owner", "Overall governance and executive approval: full lead oversight, final approvals across estimation, procurement, construction, invoicing, warranty and system administration; co-approves price variations of 5% and above"],
    ["SMM", "Sales & Marketing Manager", "Marketing, pipeline and customer conversion: full lead management, creates and approves estimations, decides approvals; approves price variations below 5% and co-approves those of 5% and above"],
    ["SREP", "Sales Representative", "Lead capture and progression: creates and updates leads, read access across delivery so customers can be kept informed; no estimation authoring"],
    ["DEST", "Designer & Estimator", "Design and estimate integrity: prepares estimations and approval submissions; read access to leads, procurement and construction"],
    ["BOM", "Business Operations Manager", "Job administration and cross-functional coordination: runs approvals, procurement and warranty administration; manages and signs off construction & commissioning"],
    ["OPC", "Operations Coordinator", "Operational coordination: runs approvals, procurement, construction and warranty administration day-to-day (no construction sign-off)"],
    ["SITEOM", "Site Operations Manager", "Site delivery: manages and signs off construction & commissioning work, maintains warranty records, reads procurement for materials readiness"],
    ["CREW", "Installation Crew", "On-site execution: reads job and procurement information, completes construction checklists, reads warranty records"],
    ["PROC", "Procurement Manager", "Purchasing and supplier delivery: creates, manages and approves purchase orders (a separate reviewer approves POs the manager raised — see approvalPolicy); reads estimation, approvals and invoicing"],
    ["FIN", "Finance & Accounts", "Financial control: creates, manages and approves invoicing; updates procurement records for payment status; read access across the pipeline"],
    ["QSM", "Quality & Safety Manager", "Quality and HSE: updates HSE records within construction & commissioning, maintains warranty & maintenance records"],
    ["OMM", "O&M Manager", "Operations & maintenance: owns warranty & maintenance including approvals; reads construction records"],
    ["SYS", "SysAdmin", "System administration: full control of users, roles and configuration plus dashboard administration; does not bypass permission checks"],
    ["HRM", "HR Manager", "Human resources: no application module access by default; grants can be added at runtime on the roles screen"],
    ["ADM", "System Administrator", "Full access; bypasses permission checks"],
];

// Codes from earlier catalogs that are no longer part of the role set. Per the
// Sep 2026 matrix cut-over, the sync strips these codes from users' role
// arrays (holders are re-assigned new roles by an admin) and deletes the rows.
const RETIRED = ["SS", "SLS", "LG", "CC", "MKT", "SUP", "ENG", "REF", "DIR", "BDM", "BOP", "SOM", "EST", "ACC"];

// Permission codes from the pre-matrix catalog, replaced by module.action
// codes below. Deleted on sync; their grants cascade.
const RETIRED_PERMISSIONS = [
    "opportunity.view", "opportunity.create", "opportunity.edit", "opportunity.delete",
    "opportunity.reassign", "opportunity.close",
    "estimate.view", "estimate.edit", "pricing.edit", "proposal.manage", "variation.manage",
    "approval.decide", "purchase_order.manage", "site_work.manage", "rebate.manage",
    "billing.request", "billing.manage",
    "document.view", "document.upload", "document.delete",
    "user.manage", "referrer.manage", "business_unit.manage", "role.manage", "audit.view",
];

// The nine matrix modules ([prefix, category label]) × five actions.
const MODULES = [
    ["leads", "Leads"],
    ["estimation", "Estimation"],
    ["approvals", "Approvals"],
    ["procurement", "Procurement & Delivery"],
    ["construction", "Construction & Commissioning"],
    ["invoicing", "Invoicing"],
    ["warranty", "Warranty & Maintenance"],
    ["admin", "System Administration"],
    ["dashboards", "Dashboards & Reporting"],
];
const ACTIONS = [
    ["create", "Create"],
    ["read", "View"],
    ["update", "Update"],
    ["delete", "Delete"],
    ["approve", "Approve"],
];

// [code, name, category]
const PERMISSIONS = MODULES.flatMap(([prefix, label]) =>
    ACTIONS.map(([action, verb]) => [`${prefix}.${action}`, `${verb} ${label}`, label])
).concat([
    ["construction.checklists.update", "Update construction checklists", "Construction & Commissioning"],
    ["construction.hse.update", "Update HSE records", "Construction & Commissioning"],
]);

const ALL = PERMISSIONS.map(([code]) => code);
const of = (prefix, ...actions) => actions.map((action) => `${prefix}.${action}`);

// Default grant sets — a literal transcription of the matrix rows
// (C=create, R=read, U=update, D=delete, A=approve). Starting points only,
// edited at runtime per role. ADM bypasses checks; seeded in full for
// visibility. HRM has no module access per the matrix.
const GRANTS = {
    ADM: ALL,
    BO: [
        ...of("leads", "create", "read", "approve", "delete"),
        ...of("estimation", "read", "approve"),
        ...of("approvals", "approve"),
        ...of("procurement", "read", "approve"),
        ...of("construction", "read", "approve"),
        ...of("invoicing", "read", "approve"),
        ...of("warranty", "read", "approve"),
        ...of("admin", "read", "approve"),
        ...of("dashboards", "read"),
    ],
    SMM: [
        ...of("leads", "create", "read", "update", "delete", "approve"),
        ...of("estimation", "create", "read", "update", "approve"),
        ...of("approvals", "approve"),
        ...of("procurement", "read"),
        ...of("construction", "read"),
        ...of("invoicing", "read"),
        ...of("warranty", "read"),
        ...of("admin", "read"),
        ...of("dashboards", "read"),
    ],
    SREP: [
        ...of("leads", "create", "read", "update"),
        ...of("estimation", "read"),
        ...of("approvals", "read"),
        ...of("procurement", "read"),
        ...of("construction", "read"),
        ...of("invoicing", "read"),
        ...of("warranty", "read"),
        ...of("dashboards", "read"),
    ],
    DEST: [
        ...of("leads", "read"),
        ...of("estimation", "create", "read", "update"),
        ...of("approvals", "create", "read", "update"),
        ...of("procurement", "read"),
        ...of("construction", "read"),
        ...of("dashboards", "read"),
    ],
    BOM: [
        ...of("leads", "read"),
        ...of("estimation", "read"),
        ...of("approvals", "create", "read", "update"),
        ...of("procurement", "create", "read", "update"),
        ...of("construction", "create", "read", "update", "approve"),
        ...of("invoicing", "read"),
        ...of("warranty", "create", "read", "update"),
        ...of("dashboards", "read"),
    ],
    OPC: [
        ...of("leads", "read"),
        ...of("estimation", "read"),
        ...of("approvals", "create", "read", "update"),
        ...of("procurement", "create", "read", "update"),
        ...of("construction", "create", "read", "update"),
        ...of("invoicing", "read"),
        ...of("warranty", "create", "read", "update"),
        ...of("dashboards", "read"),
    ],
    SITEOM: [
        ...of("procurement", "read"),
        ...of("construction", "create", "read", "update", "approve"),
        ...of("warranty", "create", "read", "update"),
        ...of("dashboards", "read"),
    ],
    CREW: [
        ...of("procurement", "read"),
        ...of("construction", "read"),
        "construction.checklists.update",
        ...of("warranty", "read"),
    ],
    PROC: [
        ...of("estimation", "read"),
        ...of("approvals", "read"),
        ...of("procurement", "create", "read", "update", "approve"),
        ...of("construction", "read"),
        ...of("invoicing", "read"),
        ...of("dashboards", "read"),
    ],
    FIN: [
        ...of("leads", "read"),
        ...of("estimation", "read"),
        ...of("approvals", "read"),
        ...of("procurement", "read", "update"),
        ...of("invoicing", "create", "read", "update", "approve"),
        ...of("warranty", "read"),
        ...of("dashboards", "read"),
    ],
    QSM: [
        ...of("construction", "read"),
        "construction.hse.update",
        ...of("warranty", "create", "read", "update"),
        ...of("dashboards", "read"),
    ],
    OMM: [
        ...of("construction", "read"),
        ...of("warranty", "create", "read", "update", "approve"),
        ...of("dashboards", "read"),
    ],
    SYS: [
        ...of("admin", "create", "read", "update", "delete", "approve"),
        ...of("dashboards", "read", "update"),
    ],
    HRM: [],
};

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface) {
        const { sequelize } = queryInterface;

        // 1. Clear retired role codes off users (matrix cut-over decision:
        //    holders are re-assigned new roles by an admin), then delete the
        //    role rows — their grants cascade.
        for (const code of RETIRED) {
            await sequelize.query(
                "UPDATE users SET roles = array_remove(roles, :code), updated_at = NOW() WHERE :code = ANY(roles)",
                { replacements: { code } }
            );
            await queryInterface.bulkDelete("roles", { code });
        }

        // 2. Delete permissions from the pre-matrix catalog; grants cascade,
        //    which also frees ADM to be re-seeded with the new catalog below.
        await queryInterface.bulkDelete("permissions", { code: RETIRED_PERMISSIONS });

        // 3. Upsert the role catalog: display fields converge on re-run.
        for (const [code, name, description] of ROLES) {
            await sequelize.query(
                `INSERT INTO roles (code, name, description, is_system, is_active, created_at, updated_at)
                 VALUES (:code, :name, :description, true, true, NOW(), NOW())
                 ON CONFLICT (code) DO UPDATE
                 SET name = EXCLUDED.name, description = EXCLUDED.description, is_system = true, updated_at = NOW()`,
                { replacements: { code, name, description } }
            );
        }

        // 4. Upsert the permission catalog.
        for (const [code, name, category] of PERMISSIONS) {
            await sequelize.query(
                `INSERT INTO permissions (code, name, category, is_system, created_at, updated_at)
                 VALUES (:code, :name, :category, true, NOW(), NOW())
                 ON CONFLICT (code) DO UPDATE
                 SET name = EXCLUDED.name, category = EXCLUDED.category, is_system = true, updated_at = NOW()`,
                { replacements: { code, name, category } }
            );
        }

        // 5. Seed default grants — only for roles with NO grants yet, so
        //    runtime edits survive re-seeding.
        const [roleRows] = await sequelize.query("SELECT id, code FROM roles");
        const [permRows] = await sequelize.query("SELECT id, code FROM permissions");
        const [grantedRows] = await sequelize.query("SELECT DISTINCT role_id FROM role_permissions");
        const roleId = Object.fromEntries(roleRows.map((r) => [r.code, r.id]));
        const permId = Object.fromEntries(permRows.map((p) => [p.code, p.id]));
        const alreadyGranted = new Set(grantedRows.map((r) => r.role_id));

        const now = new Date();
        const rows = [];
        for (const [role, codes] of Object.entries(GRANTS)) {
            if (alreadyGranted.has(roleId[role])) continue;
            for (const code of codes) {
                rows.push({
                    role_id: roleId[role],
                    permission_id: permId[code],
                    created_at: now,
                    updated_at: now,
                });
            }
        }
        if (rows.length) await queryInterface.bulkInsert("role_permissions", rows);
    },

    async down(queryInterface) {
        // Removes only catalog rows this seeder owns (grants cascade); roles
        // and permissions created at runtime are left untouched.
        await queryInterface.bulkDelete("permissions", { code: ALL });
        await queryInterface.bulkDelete("roles", { code: ROLES.map(([code]) => code) });
    },
};
