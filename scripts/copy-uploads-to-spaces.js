// One-off move to DigitalOcean Spaces: copies document files that were stored
// on local disk before the API switched to Spaces into the Space configured by
// the DO_SPACES_* variables, under the same key. The documents table stores the
// key, so no rows change. Safe to re-run: objects are overwritten with the same
// bytes.
//
//   npm run storage:copy-to-spaces              (reads ./uploads)
//   npm run storage:copy-to-spaces -- <folder>  (reads another folder)
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { Op } from "sequelize";
import db, { sequelize } from "../models/index.js";
import storage from "../utils/storage.js";

const sourceDir = path.resolve(process.argv[2] || "uploads");

const docs = await db.Document.findAll({
    where: { url: { [Op.ne]: null } },
    attributes: ["id", "url", "mime"],
    order: [["id", "ASC"]],
});

let copied = 0;
let notFound = 0;
let failed = 0;
for (const doc of docs) {
    const file = path.resolve(sourceDir, doc.url);
    try {
        if (!file.startsWith(sourceDir + path.sep) || !fs.existsSync(file)) {
            notFound += 1;
            console.log(`not local  #${doc.id} ${doc.url}`);
            continue;
        }
        const { size } = fs.statSync(file);
        await storage.put(doc.url, fs.createReadStream(file), { contentType: doc.mime || "application/octet-stream", size });
        copied += 1;
        console.log(`copied     #${doc.id} ${doc.url}`);
    } catch (err) {
        failed += 1;
        console.error(`failed     #${doc.id} ${doc.url}: ${err.message}`);
    }
}

console.log(`\n${docs.length} documents: ${copied} copied, ${notFound} not found in ${sourceDir}, ${failed} failed.`);
await sequelize.close();
process.exitCode = failed ? 1 : 0;
