import jwt from "jsonwebtoken";

// Signing/verification for the auth layer. The token carries only the user id
// (sub) — roles and status are re-read from the database on every request by
// the tokenValidator middleware, so a role change or account disable takes
// effect immediately instead of when the token expires.

const secret = () => {
    if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET env var is not set");
    return process.env.JWT_SECRET;
};

export const signToken = (user) =>
    jwt.sign({ sub: String(user.id) }, secret(), {
        expiresIn: process.env.JWT_EXPIRES_IN || "1d",
    });

// Short-lived token that can only fetch one document (scope + doc claims are
// checked by tokenValidator / the download handler). Lets <img> and links
// load protected files without putting the session token in a URL.
export const signDownloadToken = (user, documentId) =>
    jwt.sign({ sub: String(user.id), scope: "download", doc: Number(documentId) }, secret(), {
        expiresIn: process.env.DOWNLOAD_TOKEN_EXPIRES_IN || "2h",
    });

// Short-lived token for the notification stream. EventSource cannot set an
// Authorization header, so the browser fetches this over the normal API and
// puts it in the stream URL; it opens nothing else (scope is checked by
// tokenValidator against the route's declared scope).
export const signStreamToken = (user) =>
    jwt.sign({ sub: String(user.id), scope: "stream" }, secret(), {
        expiresIn: process.env.STREAM_TOKEN_EXPIRES_IN || "12h",
    });

export const verifyToken = (token) => jwt.verify(token, secret());
