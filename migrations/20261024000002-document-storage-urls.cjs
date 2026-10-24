"use strict";

// Uploaded files keep their address in the Space (Oct 2026).
//
//   documents.storage_url                 the file's public URL in the Space,
//   collaboration_attachments.storage_url beside its key — what the screens
//                                         open. Before this only the key was
//                                         kept, and the screens opened files
//                                         through an API link built from
//                                         BACKEND_URL with a token that ran
//                                         out after 2 hours; links saved into
//                                         checklist answers died with it.
//   documents.category                    the attachment category it was
//                                         uploaded under (photo, bill,
//                                         client_document, delivery_receipt…).
//                                         Two categories share the type
//                                         "evidence", so the type alone could
//                                         not say which a file was: client
//                                         documents came back as delivery
//                                         receipts.
//
// Existing rows are filled in: the URL from the key and the DO_SPACES_*
// settings (the same address utils/storage.js publicUrl builds — keep the two
// in step), the category from the type, or — for files attached on a
// procurement checklist — from the checklist item that holds them.

// prestige-fe constants/procurement.js UPLOAD_CATEGORY_FOR_ITEM.
const CATEGORY_FOR_ITEM = {
    quoteFile: "supplier_quote",
    finalQuoteFile: "supplier_quote",
    poRecords: "purchase_order",
    receiptFiles: "delivery_receipt",
    discrepancyPhotos: "delivery_receipt",
};
// The one category each of these types was uploaded under.
const CATEGORY_FOR_TYPE = {
    site_photo: "photo",
    drawing: "sketch",
    energy_bill: "bill",
    lead: "document",
    evidence: "client_document",
    supplier_quote: "supplier_quote",
};

const publicBase = () => {
    const custom = String(process.env.DO_SPACES_PUBLIC_URL || "").trim();
    if (custom) return custom.replace(/\/+$/, "");
    if (!process.env.DO_SPACES_ENDPOINT || !process.env.DO_SPACES_BUCKET) return null;
    const endpoint = new URL(process.env.DO_SPACES_ENDPOINT);
    const bucket = process.env.DO_SPACES_BUCKET;
    return process.env.DO_SPACES_FORCE_PATH_STYLE === "true" ? `${endpoint.origin}/${bucket}` : `${endpoint.protocol}//${bucket}.${endpoint.host}`;
};
const urlFor = (base, key) => `${base}/${String(key).split("/").map(encodeURIComponent).join("/")}`;

/** { documentId → category } for the files a procurement checklist item holds. */
const categoriesFromChecklists = (rows) => {
    const found = new Map();
    for (const { checklist } of rows) {
        for (const answers of Object.values(checklist && typeof checklist === "object" ? checklist : {})) {
            for (const [item, value] of Object.entries(answers && typeof answers === "object" ? answers : {})) {
                if (!CATEGORY_FOR_ITEM[item] || !Array.isArray(value)) continue;
                for (const file of value) if (Number.isInteger(Number(file?.id))) found.set(Number(file.id), CATEGORY_FOR_ITEM[item]);
            }
        }
    }
    return found;
};

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.addColumn("documents", "storage_url", { type: Sequelize.STRING(1000), allowNull: true });
        await queryInterface.addColumn("documents", "category", { type: Sequelize.STRING(30), allowNull: true });
        await queryInterface.addColumn("collaboration_attachments", "storage_url", { type: Sequelize.STRING(1000), allowNull: true });

        const q = (sql, replacements) => queryInterface.sequelize.query(sql, { replacements, type: Sequelize.QueryTypes.SELECT });
        // A row whose url is already a full link (a file kept elsewhere) is its own address.
        await queryInterface.sequelize.query("UPDATE documents SET storage_url = url WHERE url LIKE 'http%'");
        const base = publicBase();
        if (!base) {
            console.warn("DO_SPACES_ENDPOINT / DO_SPACES_BUCKET not set — storage_url left empty; the screens fall back to the API's download links.");
        } else {
            for (const row of await q("SELECT id, url FROM documents WHERE url IS NOT NULL AND url NOT LIKE 'http%'"))
                await queryInterface.sequelize.query("UPDATE documents SET storage_url = :url WHERE id = :id", { replacements: { id: row.id, url: urlFor(base, row.url) } });
            for (const row of await q("SELECT id, storage_key FROM collaboration_attachments WHERE storage_key IS NOT NULL"))
                await queryInterface.sequelize.query("UPDATE collaboration_attachments SET storage_url = :url WHERE id = :id", {
                    replacements: { id: row.id, url: urlFor(base, row.storage_key) },
                });
        }

        const fromChecklists = categoriesFromChecklists(await q("SELECT checklist FROM procurement_jobs"));
        for (const row of await q("SELECT id, type FROM documents")) {
            const category = fromChecklists.get(row.id) ?? CATEGORY_FOR_TYPE[row.type] ?? null;
            if (category) await queryInterface.sequelize.query("UPDATE documents SET category = :category WHERE id = :id", { replacements: { id: row.id, category } });
        }
    },

    async down(queryInterface) {
        await queryInterface.removeColumn("collaboration_attachments", "storage_url");
        await queryInterface.removeColumn("documents", "category");
        await queryInterface.removeColumn("documents", "storage_url");
    },
};
