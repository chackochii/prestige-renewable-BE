// Runs a real document upload through the same service the API route uses, and
// prints the exact failure. The HTTP layer answers 500 "Internal server error"
// on purpose, and in production the logger writes only to logs/error.log — so
// when an upload breaks there is often nothing visible to go on.
//
//   node -r dotenv/config scripts/check-upload.js
//
// It creates one throwaway opportunity, uploads a 13-byte text file, then
// deletes the object from Spaces and removes every record it made.

import "dotenv/config";
import db from "../models/index.js";
import storage from "../utils/storage.js";
import { addDocuments } from "../modules/opportunity/service/leadAttachmentService.js";

const step = (s) => console.log(`\n--- ${s} ---`);
const ok = (s) => console.log(`  OK    ${s}`);
const bad = (s) => console.log(`  FAIL  ${s}`);

let opportunity = null;
let created = [];

const explain = (err) => {
    const cause = err.original ?? err.parent;
    console.log(bad(`${err.name}: ${err.message}`));
    if (err.status) console.log(`        the API would answer ${err.status} with this message`);
    else console.log("        no .status — the API would answer 500 and hide this from the client");
    if (cause?.code) console.log(`        postgres code ${cause.code}${cause.column ? ` on column "${cause.column}"` : ""}`);
    if (cause?.detail) console.log(`        ${cause.detail}`);
    if (err.$metadata?.httpStatusCode) console.log(`        object storage HTTP ${err.$metadata.httpStatusCode}`);
    if (err.stack) console.log(`\n${err.stack.split("\n").slice(0, 6).map((l) => `        ${l}`).join("\n")}`);
};

try {
    step("environment");
    console.log("  NODE_ENV        :", process.env.NODE_ENV ?? "(unset → development)");
    console.log("  node            :", process.version);
    console.log("  database        :", `${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`);
    await db.sequelize.authenticate();
    ok("database reachable");

    step("documents table");
    const [cols] = await db.sequelize.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'documents'"
    );
    const have = new Set(cols.map((c) => c.column_name));
    const need = ["opportunity_id", "type", "name", "size", "url", "label", "stage", "mime", "mirror_status"];
    const absent = need.filter((c) => !have.has(c));
    if (absent.length) bad(`missing columns: ${absent.join(", ")} — run npm run db:migrate`);
    else ok(`all ${need.length} columns the upload writes are present`);

    step("a record to attach to");
    const unit = await db.BusinessUnit.findOne({ order: [["id", "ASC"]] });
    if (!unit) throw Object.assign(new Error("no business unit exists to attach a test record to"), { status: 400 });
    opportunity = await db.Opportunity.create({
        businessUnitId: unit.id,
        number: `ZZCHK-${Date.now().toString(36)}`,
        customerLegalName: "ZZ upload diagnostic (temporary)",
        stage: 1,
        lifecycle: "Active",
    });
    ok(`created opportunity #${opportunity.id} in ${unit.code}`);

    step("upload through the real service");
    const file = {
        originalname: "zz-upload-diagnostic.txt",
        buffer: Buffer.from("upload check\n"),
        size: 13,
        mimetype: "text/plain",
    };
    const docs = await addDocuments(opportunity.id, [file], { type: "other" }, null);
    created = docs;
    ok(`stored and recorded: document #${docs[0].id}`);

    step("read it back out of object storage");
    const row = await db.Document.findByPk(docs[0].id);
    const back = await storage.open(row.url);
    const chunks = [];
    for await (const c of back.body) chunks.push(c);
    ok(`${Buffer.concat(chunks).length} bytes read back from ${row.url}`);

    console.log("\nUploads work. Whatever is failing is not this path.\n");
} catch (err) {
    console.log("");
    explain(err);
    console.log("\nThat is the error the API is hiding behind its 500.\n");
    process.exitCode = 1;
} finally {
    // Remove everything this script made, whether it succeeded or not.
    if (opportunity) {
        const docs = await db.Document.findAll({ where: { opportunityId: opportunity.id } }).catch(() => []);
        for (const d of docs) {
            if (d.url) await storage.remove(d.url).catch(() => {});
            await d.destroy({ force: true }).catch(() => {});
        }
        await db.Opportunity.destroy({ where: { id: opportunity.id }, force: true }).catch(() => {});
        console.log(`cleanup: removed opportunity #${opportunity.id} and ${docs.length} document(s)`);
    }
    await db.sequelize.close();
}
