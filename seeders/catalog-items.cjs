"use strict";

// Starter product catalog for the quote builder (AUD ex GST). Idempotent:
// only keys that do not exist yet are inserted, so it can run on every
// deploy (`npm run update`) without touching prices someone has edited.

const ITEMS = [
    // key, name, unit, brands [name, unitPrice]
    ["solar_panel", "Solar panel", "panel", [["Jinko Tiger Neo 440W", 185], ["Trina Vertex S+ 440W", 180], ["LONGi Hi-MO 6 440W", 195], ["REC Alpha Pure-R 430W", 320]]],
    ["string_inverter", "Solar inverter (grid-tied)", "unit", [["Fronius Primo GEN24 5kW", 1650], ["SMA Sunny Boy 5.0", 1500], ["Sungrow SG5.0RS", 1050], ["GoodWe DNS 5kW", 900]]],
    ["hybrid_inverter", "Hybrid inverter", "unit", [["Sungrow SH5.0RS", 2300], ["Fronius Primo GEN24 Plus 5kW", 2600], ["GoodWe EH 5kW", 1900]]],
    ["battery", "Battery storage", "kWh", [["Tesla Powerwall 3", 1050], ["Sungrow SBR HV", 780], ["BYD Battery-Box Premium HVM", 820], ["AlphaESS SMILE", 700]]],
    ["ev_charger", "EV charger", "unit", [["Tesla Wall Connector Gen 3", 950], ["Wallbox Pulsar Plus", 1150], ["myenergi zappi", 1450]]],
    ["mounting", "Mounting & railing", "panel", [["Clenergy PV-ezRack", 45], ["Sunlock", 42], ["Schletter", 55]]],
    ["dc_cable", "DC solar cable", "m", [["Prysmian Tecsun 6mm²", 4.2], ["Nexans 6mm²", 3.9]]],
    ["switchboard_upgrade", "Switchboard upgrade", "job", [["Clipsal", 1800], ["Hager", 1650]]],
    ["monitoring", "Monitoring & smart meter", "unit", [["Solar Analytics", 480], ["Fronius Smart Meter", 320]]],
    ["install_labour", "Installation labour", "hour", [["Standard installer", 95], ["Licensed electrician", 135]]],
    ["design_engineering", "Design & engineering", "job", [["In-house design", 1200], ["External consultant", 2500]]],
];

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface) {
        const [existing] = await queryInterface.sequelize.query('SELECT key FROM catalog_items');
        const present = new Set(existing.map((row) => row.key));
        const now = new Date();
        const rows = ITEMS.filter(([key]) => !present.has(key)).map(([key, name, unit, brands], index) => ({
            key,
            name,
            unit,
            brands: JSON.stringify(brands.map(([brandName, unitPrice]) => ({ name: brandName, unitPrice }))),
            is_active: true,
            sort_order: index,
            created_at: now,
            updated_at: now,
        }));
        if (rows.length) await queryInterface.bulkInsert("catalog_items", rows);
    },

    async down(queryInterface) {
        await queryInterface.bulkDelete("catalog_items", { key: ITEMS.map(([key]) => key) });
    },
};
