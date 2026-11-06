"use strict";

// Unit branding (prestige-fe PR #20, Nov 2026). Each business unit trades as
// one of two companies, and that decides the logo on the sidebar, on the public
// enquiry, site-visit and proposal pages, and in the quote and BOQ PDFs. The
// frontend keeps the logo files; the API says which set a unit uses.
//
//   business_units.brand   prestige | sydpro (businessUnit.UNIT_BRANDS), default prestige
//
// Units coded or named Sydpro are marked sydpro; every other unit keeps Prestige's.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.addColumn("business_units", "brand", {
            type: Sequelize.STRING(20),
            allowNull: false,
            defaultValue: "prestige",
        });
        await queryInterface.sequelize.query(
            "UPDATE business_units SET brand = 'sydpro' WHERE code ILIKE 'SYD%' OR name ILIKE 'sydpro%' OR legal_name ILIKE 'sydpro%'"
        );
    },

    async down(queryInterface) {
        await queryInterface.removeColumn("business_units", "brand");
    },
};
