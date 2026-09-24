// File storage for uploaded documents: DigitalOcean Spaces (S3-compatible
// object storage). Objects are private (the Space default); files are streamed
// back through the API's download route, so access checks and download tokens
// apply.
//
// Keys are relative, forward-slash paths ("opportunities/12/<file>") and are
// what the documents table stores in `url`.
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const httpError = (status, message) => Object.assign(new Error(message), { status });

const REQUIRED_VARS = ["DO_SPACES_ENDPOINT", "DO_SPACES_BUCKET", "DO_SPACES_KEY", "DO_SPACES_SECRET"];

// Checked when the module loads, so a misconfigured environment fails on boot
// rather than on the first upload.
const absent = REQUIRED_VARS.filter((name) => !process.env[name]);
if (absent.length) throw new Error(`DigitalOcean Spaces storage needs ${absent.join(", ")} in .env`);

const bucket = process.env.DO_SPACES_BUCKET;

const client = new S3Client({
    endpoint: process.env.DO_SPACES_ENDPOINT,
    // Routing comes from the endpoint; the region only goes into the request
    // signature. Spaces accepts either the region slug ("syd1") or the
    // us-east-1 that DigitalOcean's older docs suggest — both were verified
    // against this bucket. The slug is set in .env because it says where the
    // data actually lives.
    region: process.env.DO_SPACES_REGION || "us-east-1",
    forcePathStyle: false,
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

const storage = {
    /** body: Buffer, or a stream with `size` given. */
    async put(key, body, { contentType, size } = {}) {
        await client.send(
            new PutObjectCommand({
                Bucket: bucket,
                Key: checkKey(key),
                Body: body,
                ContentType: contentType,
                // Streams need an explicit length; buffers carry their own.
                ...(size !== undefined ? { ContentLength: size } : {}),
            }),
        );
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
