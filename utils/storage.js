// File storage for uploaded documents: DigitalOcean Spaces (S3-compatible
// object storage). Objects are uploaded public-read, so each has a permanent
// address in the Space (publicUrl) — that is what the database keeps beside
// the key (documents.storage_url, collaboration_attachments.storage_url) and
// what the screens open. The API's download routes still stream a file by its
// key, for anything recorded without an address.
//
// Keys are relative, forward-slash paths, one folder per lead named by its
// number ("SYD-26-0001/<file>", "SYD-26-0001/site-visit/<photo>"): the
// documents table stores them in `url`, collaboration_attachments in
// `storage_key`. DO_SPACES_PUBLIC_URL, when set (a CDN or custom domain in
// front of the Space), is used as the base of the address instead of the
// Space's own host.
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const httpError = (status, message) => Object.assign(new Error(message), { status });

const REQUIRED_VARS = ["DO_SPACES_ENDPOINT", "DO_SPACES_BUCKET", "DO_SPACES_KEY", "DO_SPACES_SECRET"];

// Checked when the module loads, so a misconfigured environment fails on boot
// rather than on the first upload.
const absent = REQUIRED_VARS.filter((name) => !process.env[name]);
if (absent.length) throw new Error(`DigitalOcean Spaces storage needs ${absent.join(", ")} in .env`);

const bucket = process.env.DO_SPACES_BUCKET;
const forcePathStyle = process.env.DO_SPACES_FORCE_PATH_STYLE === "true";

const client = new S3Client({
    endpoint: process.env.DO_SPACES_ENDPOINT,
    // Routing comes from the endpoint; the region only goes into the request
    // signature. Spaces accepts either the region slug ("syd1") or the
    // us-east-1 that DigitalOcean's older docs suggest — both were verified
    // against this bucket. The slug is set in .env because it says where the
    // data actually lives.
    region: process.env.DO_SPACES_REGION || "us-east-1",
    // Spaces takes the bucket in the hostname. A local S3-compatible store
    // (MinIO, an emulator) usually cannot, as bucket.localhost does not resolve;
    // DO_SPACES_FORCE_PATH_STYLE=true puts the bucket in the path instead.
    forcePathStyle,
    // The SDK's default integrity checksums (aws-chunked uploads with a CRC32
    // trailer) are AWS-specific; S3-compatible stores can save the chunk
    // framing as file bytes. Only send checksums where S3 requires them.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: { accessKeyId: process.env.DO_SPACES_KEY, secretAccessKey: process.env.DO_SPACES_SECRET },
});

/** Rejects malformed keys. Keys are server-generated, so this is a backstop. */
const checkKey = (key) => {
    const value = String(key || "");
    if (!value || value.startsWith("/") || value.includes("\\") || value.split("/").includes(".."))
        throw httpError(400, "Invalid document path");
    return value;
};

/** Where the Space serves objects from: https://<bucket>.<region host>, or the configured CDN / custom domain. */
const publicBase = () => {
    const custom = String(process.env.DO_SPACES_PUBLIC_URL || "").trim();
    if (custom) return custom.replace(/\/+$/, "");
    const endpoint = new URL(process.env.DO_SPACES_ENDPOINT);
    return forcePathStyle ? `${endpoint.origin}/${bucket}` : `${endpoint.protocol}//${bucket}.${endpoint.host}`;
};

/** Types a browser shows in the tab rather than downloading (as the API's download routes do). */
const INLINE = /^(image\/|application\/pdf$)/;

/**
 * How the Space answers for the object: shown in the tab or downloaded, under
 * the name it was uploaded with rather than the generated key.
 */
const dispositionFor = (filename, contentType) => {
    const name = String(filename || "file");
    const ascii = name.replace(/[^\x20-\x7e]+/g, "_").replace(/["\\]/g, "_");
    const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    return `${INLINE.test(contentType || "") ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
};

const storage = {
    /** The object's permanent address in the Space — what the database stores and the screens open. */
    publicUrl(key) {
        return `${publicBase()}/${checkKey(key).split("/").map(encodeURIComponent).join("/")}`;
    },

    /**
     * body: Buffer, or a stream with `size` given. `filename` is the name the
     * file was uploaded with, served back to whoever opens it. → the object's
     * public URL.
     */
    async put(key, body, { contentType, size, filename } = {}) {
        await client.send(
            new PutObjectCommand({
                Bucket: bucket,
                Key: checkKey(key),
                Body: body,
                ContentType: contentType,
                ACL: "public-read",
                ...(filename ? { ContentDisposition: dispositionFor(filename, contentType) } : {}),
                // Streams need an explicit length; buffers carry their own.
                ...(size !== undefined ? { ContentLength: size } : {}),
            }),
        );
        return storage.publicUrl(key);
    },

    /** → { body (stream), size }; 404 when the object does not exist. */
    async open(key) {
        try {
            const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: checkKey(key) }));
            return { body: object.Body, size: object.ContentLength };
        } catch (err) {
            if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404)
                throw httpError(404, "The stored file is missing");
            throw err;
        }
    },

    async remove(key) {
        // S3 deletes are idempotent — a missing object is not an error.
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: checkKey(key) }));
    },
};

export default storage;
