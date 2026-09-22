// Shared by sequelize-cli (migrations/seeders) and the runtime connection.
// CommonJS because sequelize-cli cannot load ESM config.
// Env vars are loaded before this file runs: server.js uses `import "dotenv/config"`,
// and the db:* npm scripts preload it with `node -r dotenv/config`.

const fs = require("node:fs");

// TLS is opt-in, because the two kinds of server disagree about it: a managed
// database (DigitalOcean, RDS) requires it, while a local Postgres does not
// offer it at all and refuses a connection that insists on it.
//
// Encryption alone does not say who is on the other end. Point DB_CA_CERT at
// the provider's CA file and the certificate is verified properly; without one
// the connection is encrypted but unauthenticated, which anyone able to sit in
// the path can exploit. Production always uses TLS whatever DB_SSL says.
const sslOptions = ({ required = false } = {}) => {
    if (!required && process.env.DB_SSL !== "true") return {};
    const ca = process.env.DB_CA_CERT ? fs.readFileSync(process.env.DB_CA_CERT, "utf8") : null;
    return { ssl: { require: true, rejectUnauthorized: Boolean(ca), ...(ca ? { ca } : {}) } };
};

const base = {
    username: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "postgres",
    database: process.env.DB_NAME || "prestige",
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT) || 5432,
    dialect: "postgres",
    dialectOptions: sslOptions(),
    define: {
        underscored: true, // snake_case columns in the database
    },
    logging: false,
};

module.exports = {
    development: base,
    test: { ...base, database: `${base.database}_test` },
    production: { ...base, dialectOptions: sslOptions({ required: true }) },
};
