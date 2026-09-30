# Aqdi (عقدي)

A Saudi SaaS platform that helps real-estate offices manage rental contracts.
Offices upload the contract file they downloaded from Ejar; the app reads only
dates and amounts, tracks deadlines and reminds landlords and tenants. The app
never connects to Ejar and is not affiliated with it.

The UI is Arabic and right-to-left. Code, comments and commits are in English.

## Stack

Node.js 20 + Express 4 + EJS templates + MySQL (`mysql2`) + `node-cron`.
No frontend framework, no build step, no ORM. The app is deployed to shared
cPanel hosting, so the dependency list is fixed; see `CLAUDE.md` before adding one.

## Run locally

1. Install Node.js 20.9 or newer and MySQL 8.0.13+ (or MariaDB 10.2+).
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy the environment file and fill in at least the `DB_*` values:
   ```bash
   cp .env.example .env
   ```
4. Start the server:
   ```bash
   npm start
   ```
   Open http://localhost:3000. At startup the app creates any missing table
   (`database/schema.js`). It still starts if the database is unreachable;
   `/health` reports the database status.
5. Insert the default plans, message templates and settings (safe to repeat):
   ```bash
   npm run seed
   ```
6. Run the tests:
   ```bash
   npm test
   ```
   Database tests are skipped unless `TEST_DB_NAME` names a separate, empty
   database the `DB_USER` can write to.

## Project layout

| Path | Purpose |
|---|---|
| `server.js` | Express app: security headers, static files, routes, error handlers |
| `config/db.js` | MySQL pool and `ensureSchema()`, run at startup |
| `database/` | `schema.js` (all tables, in creation order) and `seed.js` (default rows) |
| `routes/` | HTTP routes |
| `middleware/` | 404 and error handlers |
| `services/` | Business logic: `scopeToOffice.js` (office isolation), `audit.js`, `inviteCode.js`, `assetVersion.js` |
| `utils/` | Logger and time helpers |
| `views/` | EJS layout, partials, pages and error pages |
| `public/` | Static CSS/JS served with fingerprinted URLs |
| `tests/` | `node --test` test files |
| `reference/` | Schema and security tests from an earlier prototype, for reference only |

## Blueprint

The project rules, roles, stack constraints and the fixed list of table names
live in [`CLAUDE.md`](CLAUDE.md). Read it before making changes.
