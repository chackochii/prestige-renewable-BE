// Diagnoses object storage from wherever it is run — a laptop, a droplet, CI.
// Uploads failing with a 500 tell you nothing on their own, because the API
// deliberately hides internals from the client; this prints the actual cause.
//
//   node -r dotenv/config scripts/check-spaces.js
//
// Read-only: it resolves the config, inspects the TLS certificate and lists at
// most one object. It never writes to the bucket.

import "dotenv/config";
import tls from "node:tls";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";

const mask = (v) => (v ? `${String(v).slice(0, 4)}…${String(v).slice(-2)}` : "(not set)");
const ok = (s) => `  OK    ${s}`;
const bad = (s) => `  FAIL  ${s}`;

const endpoint = process.env.DO_SPACES_ENDPOINT;
const bucket = process.env.DO_SPACES_BUCKET;
const region = process.env.DO_SPACES_REGION || "us-east-1";

console.log("\n--- configuration ---");
console.log("  DO_SPACES_ENDPOINT :", endpoint ?? "(not set)");
console.log("  DO_SPACES_BUCKET   :", bucket ?? "(not set)");
console.log("  DO_SPACES_REGION   :", region);
console.log("  DO_SPACES_KEY      :", mask(process.env.DO_SPACES_KEY));
console.log("  DO_SPACES_SECRET   :", mask(process.env.DO_SPACES_SECRET));
console.log("  NODE_EXTRA_CA_CERTS:", process.env.NODE_EXTRA_CA_CERTS ?? "(not set)");

const missing = ["DO_SPACES_ENDPOINT", "DO_SPACES_BUCKET", "DO_SPACES_KEY", "DO_SPACES_SECRET"].filter((v) => !process.env[v]);
if (missing.length) {
    console.log(`\n${bad(`missing: ${missing.join(", ")} — the app will not even start`)}`);
    process.exit(1);
}

// The endpoint must be the *region* host. utils/storage.js uses virtual-hosted
// addressing, so the SDK prepends the bucket itself; a bucket already in the
// endpoint gets it twice, and no certificate covers a doubled label.
const host = new URL(endpoint).host;
console.log("\n--- addressing ---");
if (host.startsWith(`${bucket}.`)) {
    console.log(bad(`the endpoint already contains the bucket name`));
    console.log(`        the SDK will actually connect to: ${bucket}.${host}`);
    console.log(`        set DO_SPACES_ENDPOINT=https://${host.slice(bucket.length + 1)}`);
} else {
    console.log(ok(`endpoint is a region host; the SDK will connect to ${bucket}.${host}`));
}

const target = host.startsWith(`${bucket}.`) ? `${bucket}.${host}` : `${bucket}.${host}`;

console.log("\n--- TLS ---");
const cert = await new Promise((resolve) => {
    const s = tls.connect({ host: target, port: 443, servername: target, rejectUnauthorized: false, timeout: 15000 }, () => {
        const c = s.getPeerCertificate();
        resolve({ cn: c.subject?.CN, issuer: c.issuer?.O ?? c.issuer?.CN, to: c.valid_to, authorized: s.authorized, why: s.authorizationError });
        s.destroy();
    });
    s.on("error", (e) => resolve({ err: e.code ?? e.message }));
    s.on("timeout", () => { s.destroy(); resolve({ err: "timeout" }); });
});

if (cert.err) {
    console.log(bad(`could not connect to ${target}: ${cert.err}`));
} else {
    console.log(`  certificate for : ${cert.cn}`);
    console.log(`  issued by       : ${cert.issuer}`);
    console.log(`  expires         : ${cert.to}`);
    if (cert.authorized) console.log(ok("certificate is trusted"));
    else {
        console.log(bad(`certificate rejected: ${cert.why}`));
        if (/SELF_SIGNED/.test(cert.why))
            console.log("        something is intercepting TLS (corporate antivirus or proxy).");
        if (/ALTNAME/.test(cert.why))
            console.log(`        the certificate does not cover ${target} — check the endpoint above.`);
    }
}

console.log("\n--- signed request ---");
const client = new S3Client({
    endpoint, region, forcePathStyle: false,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: { accessKeyId: process.env.DO_SPACES_KEY, secretAccessKey: process.env.DO_SPACES_SECRET },
});
try {
    const r = await client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }));
    console.log(ok(`bucket "${bucket}" is reachable and the credentials are accepted (${r.KeyCount ?? 0} key sampled)`));
    console.log("\nObject storage is working. If uploads still fail, the cause is elsewhere.\n");
} catch (err) {
    console.log(bad(`${err.name}: ${err.message}`));
    const hint = {
        NoSuchBucket: "the bucket name is wrong, or it lives in another region.",
        InvalidAccessKeyId: "DO_SPACES_KEY does not exist — regenerate the Spaces key pair.",
        SignatureDoesNotMatch: "DO_SPACES_SECRET is wrong, or the server clock has drifted. Check `date`.",
        AccessDenied: "the key is valid but has no rights on this bucket.",
        CredentialsProviderError: "credentials were not loaded — is .env present next to the app on this host?",
    }[err.name];
    if (hint) console.log(`        ${hint}`);
    if (err.$metadata?.httpStatusCode) console.log(`        HTTP status: ${err.$metadata.httpStatusCode}`);
    console.log();
    process.exit(1);
}
