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

# Public enquiry form (optional) — unit code used when the form sends none
# PUBLIC_LEAD_UNIT_CODE=PRS
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
| `PUBLIC_LEAD_UNIT_CODE` | no | Business unit the public enquiry form files into when the request has no `businessUnit`; otherwise the first unit by code |

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

## Lead capture (stage 1) API

Leads are opportunities at stage 1. The lead fields — customer, site (incl. `siteMapUrl`), energy, source (`leadSource` + free-text `leadSourceDetails`), the mandatory-checklist fields (`leadType`, `needsClientContact` + `contactAttempts[]`, `hasOwnerDiscount` + name/amount, `needsClientVisit` + `clientVisitReason`, `customFields[]`, `notPotentialReason`) and `qualification` — go through `POST /api/opportunities` and `PATCH /api/opportunities/:id`. Everything else is an action with its own endpoint:

| Method | Route | Permission | Body → returns |
|---|---|---|---|
| `GET` | `/api/opportunities/:id/history` | `leads.read` | job history, newest first: `{ id, kind: note\|system, note, authorName, createdAt }` |
| `POST` | `/api/opportunities/:id/history` | `leads.update` | `{ note }` → the entry |
| `GET` / `POST` | `/api/opportunities/:id/meetings` | read / update | `{ attendees, outcome?, nextStep?, at? }` → the meeting entry |
| `DELETE` | `/api/opportunities/:id/meetings/:meetingId` | `leads.update` | — |
| `GET` | `/api/opportunities/:id/attachments` | `leads.read` | `[{ id, category, filename, size, mime, url, uploaderName, createdAt }]` |
| `POST` | `/api/opportunities/:id/attachments` | `leads.update` | multipart `file` + `category` (`photo` \| `sketch` \| `bill` \| `document`) → the attachment |
| `GET` | `/api/opportunities/:id/documents` | `leads.read` | generic document rows (`type`, `stage`, `label`, `fileUrl`) |
| `POST` | `/api/opportunities/:id/documents` | `leads.update` | multipart `files[]` (≤10 × 10 MB) + `type`, `stage?`, `label?` → refreshed opportunity |
| `DELETE` | `/api/opportunities/:id/documents/:docId` | `leads.update` | → refreshed opportunity |
| `GET` | `/api/opportunities/:id/documents/:docId/file` | `leads.read` or `estimation.read` | the file; `?download=1` forces a download |
| `POST` | `/api/opportunities/:id/assign-salesperson` | `leads.update` | `{ salespersonId \| null, reason? }` (reason required when unassigned) → refreshed opportunity |
| `POST` | `/api/opportunities/:id/assign-estimator` | `leads.update` | `{ estimatorId }` → refreshed opportunity |
| `POST` | `/api/opportunities/:id/assign-coordinator` | `leads.update` | `{ operationalCoordinatorId }` → refreshed opportunity |
| `POST` | `/api/opportunities/:id/notify-owner` | `leads.update` | → `{ notified, recipients[] }` — in-app `notifications` rows for the unit's active `BO` users |

Notes:

- **Files** live on disk under `UPLOAD_DIR` (default `./uploads`, git-ignored). The MIME type is derived from the extension allowlist, never from the upload; non-image/PDF types are always served as downloads with `nosniff`. Attachment `url`s carry a **download-only token** (2 h, bound to that document, `DOWNLOAD_TOKEN_EXPIRES_IN`) so `<img>`/links work without exposing a session token; the route also accepts a normal bearer token.
- **Assignments** must be active users of the record's business unit (ADM anywhere) and each writes a `system` history entry.
## Public enquiry form (no token)

The website enquiry form (`/enquiry` in prestige-fe) talks to one unauthenticated route.

| Method | Route | Body → returns |
|---|---|---|
| `POST` | `/api/public/leads` | `{ name, email, phone }` required; `siteLine1?, siteSuburb?, siteState?, sitePostcode?, message?, businessUnit? (code)` → `{ number, businessUnit }` |

A successful submission is a normal stage-1 lead (`leadSource: inbound`, `leadSourceDetails: "Website enquiry form"`, message stored in `notes`, no lead owner) and the unit's Business Owners get the same in-app notification as `notify-owner`.

### Which unit a public lead lands in

**The visitor never chooses, and never sees the list of units.** The form has no business-unit field, and there is deliberately no public route that enumerates units. The unit is decided in this order:

1. `?unit=PRS` on the link the sender followed. Signed-in staff copy these per-unit links from the Leads page or Administration → Unit settings.
2. `PUBLIC_LEAD_UNIT_CODE` in `.env`, for a bare `/enquiry` link.
3. Failing both, the first `active` or `configured` unit by code.

A `businessUnit` code that is unknown or belongs to an `inactive` unit is rejected with a "this link is not valid" message rather than quietly falling back, so a stale link is noticed instead of misfiling leads. **Set `PUBLIC_LEAD_UNIT_CODE`** if you publish the bare `/enquiry` link, otherwise the fallback unit changes if a new unit is added with an earlier code.

### Field rules

Validation lives in `modules/opportunity/service/publicLeadService.js` and runs before anything touches the database. Errors come back as `400 { message, errors: [{ field, message }] }` listing **every** problem at once. Over-long values are rejected, never truncated, so a 5-digit postcode cannot become a valid-looking 4-digit one.

| Field | Required | Rule |
|---|---|---|
| `name` | yes | 2–100 chars; Unicode letters, spaces, apostrophes, full stops, hyphens |
| `email` | yes | ≤254 chars, standard address shape, lower-cased |
| `phone` | yes | ≤30 chars of digits and `+ ( ) - space`; 8–15 digits |
| `siteLine1` | no | ≤200 chars; letters, digits, spaces and `, . ' # / -` |
| `siteSuburb` | no | ≤100 chars; letters, spaces and `' . -` |
| `siteState` | no | one of NSW ACT VIC QLD SA WA TAS NT |
| `sitePostcode` | no | exactly 4 digits |
| `message` | no | ≤2000 chars, stored in `notes` |
| `businessUnit` | no | set by the link, not the form; must exist and not be `inactive` |

### Abuse controls

| Control | Where | Behaviour |
|---|---|---|
| Body size | `routes/publicRoutes.js` | Over 8 KB → `413`; non-object JSON → `400` |
| Rate limit | `middleware/rateLimit.js` | Per IP: 10 submissions / 15 min → `429`. Tracks at most 10,000 addresses |
| Honeypot | `publicLeadService.js` | A filled `website` field returns `201` with `number: null` and creates nothing |
| Duplicate guard | `publicLeadService.js` | Same email + unit within 10 minutes returns the first lead instead of a second one |
| Input sanitising | `publicLeadService.js` | Control, zero-width and bidi characters stripped; whitespace collapsed; non-string values treated as blank |

Only these fields are accepted. Everything else in the body is ignored, so a caller cannot set `qualification`, `businessUnitId`, assignments or any other server-managed field. The response deliberately carries only the lead number and unit code, never the record.

**Behind a reverse proxy**, set `app.set("trust proxy", 1)` in `app.js` so the limiter keys on the real client IP rather than the proxy's. The limiter is per process: with several nodes, put a shared limiter in front.

## Estimation (stage 2) & quote builder API

The estimator's workflow state lives on the opportunity (`estimation*` fields, returned by every opportunity endpoint) and each step is its own endpoint. Writes need `estimation.update`; reads accept `leads.read` or `estimation.read`. The advance gate for stage 2: requirements confirmed, client input resolved (`estimationClientInfoNeeded = false`) and a quote with at least one item.

| Method | Route | Body → returns |
|---|---|---|
| `POST` | `/api/opportunities/:id/estimation/requirements` | `{ received: bool, checklistKeys?: string[], reason? }` — `received=false` needs `reason` (puts estimation on hold) → opportunity |
| `POST` | `/api/opportunities/:id/estimation/client-info` | `{ needed: bool }` → opportunity |
| `POST` | `/api/opportunities/:id/estimation/checklist` | `{ checklistValues?: {key: answer}, preSiteInspectionRequired?, siteVisitAssigneeId?, siteVisitCompleted? }` → opportunity |
| `POST` | `/api/opportunities/:id/notify-sales-manager` | notifies active `SMM` users in the unit + the salesperson (hold reason in the body) → `{ notified, recipients[] }` |
| `POST` | `/api/opportunities/:id/notify-operations-coordinator` | notifies active `OPC` users + the assigned coordinator → `{ notified, recipients[] }` |
| `GET` | `/api/opportunities/:id/quote` | quote or `null` |
| `POST` | `/api/opportunities/:id/quote` | creates it (idempotent); server sets `quoteNumber` (`PRS-Q-26-0008`), customer, estimator, date → quote |
| `PATCH` | `/api/opportunities/:id/quote` | `{ project?, projectType?, projectTypeOther?, quoteDate?, taxTreatment? (exclusive\|inclusive\|no_gst), gstRatePct? }` → quote |
| `POST` / `PATCH` / `DELETE` | `/api/opportunities/:id/quote/items[/:itemId]` | `{ itemKey, itemName, brand, unit, quantity, unitPrice, discountPct }` → item |
| `POST` / `PATCH` / `DELETE` | `/api/opportunities/:id/quote/costs[/:costId]` | `{ costType, calcType (fixed\|percentage), value, description }` → cost |
| `GET` | `/api/catalog` | any signed-in user → `[{ key, name, unit, brands: [{ name, unitPrice }] }]` (seeded by `npm run db:seed:catalog`, part of `npm run update`) |

Quote totals and GST are derived by the client from items and costs; the API stores no totals. Every assignment, hold, confirmation and notification writes a `system` entry to the job history. `POST /:id/assign-coordinator` accepts `leads.update` **or** `estimation.update` because both screens use it.

- **Qualification:** new leads default to `nurture`. Setting `qualification: "qualified"` (the "Potential client" decision) requires the checklist to be complete — lead type, site address, customer email + phone, electricity bills (flag or an uploaded bill), annual usage, lead source details, and a logged contact attempt when `needsClientContact` is set. `disqualified` requires `notPotentialReason`. Leaving stage 1 additionally needs an estimator (`POST /:id/advance`).

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
