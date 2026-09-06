"use strict";

// Per-unit workflow configuration: which pipeline stages run, which external
// approvals are gathered, and which site-work substages exist. Defaults are the
// full solar workflow so existing units keep their current behaviour; a
// communications unit can be configured with fewer stages and no approvals.

const FULL_STAGES = [1, 2, 3, 4, 5, 6, 7, 8, 9];

const FULL_APPROVAL_TYPES = [
    { key: "council", label: "Council / DA" },
    { key: "dnsp", label: "DNSP grid connection" },
    { key: "strata", label: "Facility / strata" },
    { key: "rebate", label: "Rebate pre-approval" },
];

const FULL_SITE_WORK_SUBSTAGES = [
    { key: "7a", label: "Pre-work site check" },
    { key: "7b", label: "Civil / enabling works" },
    { key: "7c", label: "Site readiness" },
    { key: "7d", label: "Installation" },
    { key: "7e", label: "Commissioning" },
];

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.addColumn("business_units", "enabled_stages", {
            type: Sequelize.JSONB,
            allowNull: false,
            defaultValue: FULL_STAGES,
        });
        await queryInterface.addColumn("business_units", "approval_types", {
            type: Sequelize.JSONB,
            allowNull: false,
            defaultValue: FULL_APPROVAL_TYPES,
        });
        await queryInterface.addColumn("business_units", "site_work_substages", {
            type: Sequelize.JSONB,
            allowNull: false,
            defaultValue: FULL_SITE_WORK_SUBSTAGES,
        });
    },

    async down(queryInterface) {
        await queryInterface.removeColumn("business_units", "enabled_stages");
        await queryInterface.removeColumn("business_units", "approval_types");
        await queryInterface.removeColumn("business_units", "site_work_substages");
    },
};
