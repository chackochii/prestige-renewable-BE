# Prestige Business Units — Backend

Sales & Delivery pipeline API for the Prestige business units (PRS, PCC, PCI, IP).

**Stack:** Node.js (ES modules) · Express 5 · PostgreSQL · Sequelize 6 · sequelize-cli migrations

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | 20.6 or newer | Project uses ES modules (`"type": "module"`) |
| PostgreSQL | 13 or newer | Migrations use the built-in `gen_random_uuid()` |
| npm | comes with Node | — |

Make sure PostgreSQL is installed and running locally (on Windows it usually runs as a service named `postgresql-x64-<version>`).

---

## 1. Install dependencies

```bash
npm install
```

## 2. Create the `.env` file

Create a `.env` file in the project root (it is git-ignored). These are all the variables the app uses:

```env
# Server
PORT=8000
BACKEND_URL=http://localhost:8000

# PostgreSQL connection
DB_HOST=127.0.0.1
DB_PORT=5432
DB_NAME=prestige
DB_USER=postgres
DB_PASSWORD=postgres

# Production only — set to "true" when the DB requires SSL
# DB_SSL=true

# Seed data (optional — defaults shown are used if omitted)
SEED_SUPERADMIN_EMAIL=superadmin@prestige.au
SEED_SUPERADMIN_PASSWORD=ChangeMe@123
```

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | no (default 8000) | Port the Express server listens on |
| `BACKEND_URL` | no | Public URL logged on startup; change per environment |
| `DB_HOST` / `DB_PORT` | yes | PostgreSQL host and port |
| `DB_NAME` | yes | Database name (`prestige`; tests use `<name>_test`) |
| `DB_USER` / `DB_PASSWORD` | yes | PostgreSQL credentials |
| `DB_SSL` | production only | `true` enables SSL for hosted databases |
| `SEED_SUPERADMIN_EMAIL` | no | Email of the seeded superadmin (default `superadmin@prestige.group`) |
| `SEED_SUPERADMIN_PASSWORD` | no | Password of the seeded superadmin, stored bcrypt-hashed (default `ChangeMe@123`) |

> Keep the `SEED_SUPERADMIN_*` values in `.env` — the seeder's rollback (`db:seed:undo`) matches on the same email it seeded with.

## 3. Create the database

```bash
npm run sequelize -- db:create
```

This creates the database named by `DB_NAME`. Skip if it already exists.

## 4. Run the migrations

```bash
npm run db:migrate
```

This creates all 17 tables in dependency order:

| Migration file | Creates |
|---|---|
| `20260822000001-create-business-units` | `business_units` |
| `20260822000002-create-users-referrers` | `users`, `referrers`, `user_business_units` |
| `20260822000003-create-opportunities` | `opportunities` |
| `20260822000004-create-quoting-tables` | `estimates`, `estimate_options`, `proposals`, `variations` |
| `20260822000005-create-delivery-tables` | `approvals`, `purchase_orders`, `site_work_substages`, `rebates` |
| `20260822000006-create-billing-system-tables` | `billing_requests`, `documents`, `audit_logs`, `notifications` |

## 5. Seed the superadmin

```bash
npm run db:seed
```

Inserts one superadmin user (role `ADM`) using the `SEED_SUPERADMIN_*` values, with the password bcrypt-hashed.

## 6. Start the server

```bash
npm run dev     # development (nodemon, auto-restart)
npm start       # production
```

Health check: `GET http://localhost:8000/health` → `{"status":"ok"}`

---

## Migration commands reference

| Command | What it does |
|---|---|
| `npm run db:migrate` | Apply all pending migrations |
| `npm run db:migrate:undo` | Roll back the most recent migration |
| `npm run db:migrate:undo:all` | Roll back everything (drops all tables) |
| `npm run db:seed` | Run all seeders |
| `npm run db:seed:undo` | Revert all seeders |
| `npm run db:reset` | Full rebuild: undo all → migrate → seed |
| `npm run sequelize -- <cmd>` | Run any raw sequelize-cli command (e.g. `db:migrate:status`, `db:create`, `db:drop`) |

Check which migrations have run:

```bash
npm run sequelize -- db:migrate:status
```

### Creating a new migration

```bash
npm run sequelize -- migration:generate --name add-my-change
```

**Important:** the generator creates a `.js` file — **rename it to `.cjs`** before running it. This project is ESM (`"type": "module"`), but sequelize-cli can only load CommonJS migration files. Same rule applies to `seed:generate`.

### Why `.cjs` files exist in an ESM project

All application code (`server.js`, `app.js`, models, routes) uses `import`/`export`. Four things must stay CommonJS because sequelize-cli loads them with `require()`: `config/config.cjs`, `.sequelizerc`, `migrations/*.cjs`, and `seeders/*.cjs`. None of them contain `require()` calls — they only use `module.exports` (the seeder loads bcryptjs via dynamic `import()`).

> Always use the npm scripts rather than bare `npx sequelize-cli` — the scripts preload `.env` (`node -r dotenv/config`); the bare CLI would run without your environment variables.

---

## Database schema overview

| Group | Tables |
|---|---|
| Core | `business_units`, `users`, `user_business_units`, `referrers` |
| Pipeline | `opportunities` (stages 1–9: Lead → Estimation → Proposal → Closure → Approvals → Procurement → Site works → Billing → Handover) |
| Quoting | `estimates`, `estimate_options`, `proposals`, `variations` |
| Delivery | `approvals`, `purchase_orders`, `site_work_substages`, `rebates` |
| Billing & system | `billing_requests`, `documents`, `audit_logs`, `notifications` |

All tables use UUID primary keys, snake_case columns, and foreign keys with cascade rules. Sequelize models live in `modules/<name>/model/` and are registered with their associations in `models/index.js`.

## Project structure

```
prestige-be/
├── server.js              # Entry point — loads env, connects DB, starts Express
├── app.js                 # Express app: middleware + routes
├── routes/index.js        # API router (mounted at /api)
├── config/
│   ├── config.cjs         # DB config shared by sequelize-cli and the app
│   └── db.js              # Sequelize instance + connectDB()
├── models/index.js        # Central model registry + associations
├── modules/<name>/model/  # One Sequelize model per table
├── migrations/*.cjs       # Schema migrations (ordered)
└── seeders/*.cjs          # Superadmin seeder
```
