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

export const verifyToken = (token) => jwt.verify(token, secret());
