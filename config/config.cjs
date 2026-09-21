// Shared by sequelize-cli (migrations/seeders) and the runtime connection.
// CommonJS because sequelize-cli cannot load ESM config.
// Env vars are loaded before this file runs: server.js uses `import "dotenv/config"`,
// and the db:* npm scripts preload it with `node -r dotenv/config`.

const base = {
    username: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "postgres",
    database: process.env.DB_NAME || "prestige",
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT) || 5432,
    dialect: "postgres",
    dialectOptions: {
        ssl: {
            require: true,
            rejectUnauthorized: false,
        },
    },
    define: {
        underscored: true, // snake_case columns in the database
    },
    logging: false,
};

module.exports = {
    development: base,
    test: { ...base, database: `${base.database}_test` },
    production: {
        ...base,
        dialectOptions:
            process.env.DB_SSL === "true" ? { ssl: { require: true, rejectUnauthorized: false } } : {},
    },
};
