// Sealing secrets at rest — the platform tokens an integration connection
// holds (a Meta Page access token gives whoever has it the page's leads).
//
// With INTEGRATION_SECRET_KEY set (32 bytes, hex or base64), seal() encrypts
// with AES-256-GCM and the stored value reads "enc:v1:<iv>:<tag>:<ciphertext>";
// open() decrypts it. Without the key the value is stored as given and a
// warning is logged once — development works, production should set the key.
// A value sealed under a key cannot be opened without it, so changing the key
// means re-entering every token.
import crypto from "node:crypto";
import logger from "./logger.js";

const PREFIX = "enc:v1:";

let warned = false;
const keyBytes = () => {
    const raw = String(process.env.INTEGRATION_SECRET_KEY ?? "").trim();
    if (!raw) return null;
    const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
    if (key.length !== 32)
        throw Object.assign(new Error("INTEGRATION_SECRET_KEY must be 32 bytes (64 hex characters or 44 base64 characters)"), { status: 500 });
    return key;
};

/** Whether secrets will be encrypted before they are stored. */
export const isSealingEnabled = () => Boolean(keyBytes());

/** Encrypts a secret for storage. Empty values stay empty. */
export const seal = (value) => {
    const text = value === undefined || value === null ? "" : String(value);
    if (!text) return text;
    const key = keyBytes();
    if (!key) {
        if (!warned) {
            warned = true;
            logger.warn("INTEGRATION_SECRET_KEY is not set — integration tokens are stored unencrypted");
        }
        return text;
    }
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    return `${PREFIX}${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${encrypted.toString("base64")}`;
};

/** The secret as it was given to seal(). A value stored in the clear comes back as-is. */
export const open = (value) => {
    const text = value === undefined || value === null ? "" : String(value);
    if (!text.startsWith(PREFIX)) return text;
    const key = keyBytes();
    if (!key) throw Object.assign(new Error("This secret is encrypted but INTEGRATION_SECRET_KEY is not set"), { status: 500 });
    const [iv, tag, encrypted] = text.slice(PREFIX.length).split(":");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
};

/** "••••1234" — enough for an admin to tell which token is in place, never the token. */
export const mask = (value) => {
    if (!value) return null;
    let plain;
    try {
        plain = open(value);
    } catch {
        return "••••";
    }
    return plain.length > 4 ? `••••${plain.slice(-4)}` : "••••";
};
