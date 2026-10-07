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
   Open http://localhost:3000. At startup the app logs a self-check block and
   creates any missing table
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

## Run locally on Windows

1. Install **Node.js 20 LTS** from https://nodejs.org (accept the defaults).
2. Install **MySQL Community Server 8** from https://dev.mysql.com/downloads/installer/
   (choose "Server only"; remember the root password you set). XAMPP's MariaDB
   10.4+ also works.
3. Create the database. Open **MySQL 8.0 Command Line Client**, enter the root
   password, then run:
   ```sql
   CREATE DATABASE aqdi CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   ```
4. Open **PowerShell** in the project folder (Shift + right-click the folder →
   "Open PowerShell window here") and run:
   ```powershell
   npm install
   Copy-Item .env.example .env
   notepad .env
   ```
5. In `.env` set at least these (leave `NODE_ENV=development`):
   ```
   DB_USER=root
   DB_PASSWORD=your MySQL root password
   DB_NAME=aqdi
   SMS_PROVIDER=console
   PLATFORM_ADMIN_PHONE=05XXXXXXXX
   ```
   and generate `JWT_SECRET` and `SECRET_BOX_KEY` with this command (run it
   twice, one value each):
   ```powershell
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   Optional, for reading uploaded contracts with AI: set `CLAUDE_API_KEY`
   (and `CLAUDE_MODEL`, default `claude-sonnet-4-5`). Without a key the app
   still runs and contracts are entered by hand.
6. Start it with `npm start` and open http://localhost:3000. The self-check
   block in the PowerShell window tells you if anything is missing.
7. Sign in at http://localhost:3000/login: the login code appears in the same
   PowerShell window on a line starting with `[SMS-CONSOLE]`.
8. Stop the server with Ctrl + C.

## Deploy to cPanel

Step-by-step guide in Arabic: [`deploy/DEPLOY-CPANEL.md`](deploy/DEPLOY-CPANEL.md). Technical reference, cron lines, pre-launch checklist and rollback: [`DEPLOY.md`](DEPLOY.md).
Pushes to `main` are tested by `.github/workflows/ci.yml` and, when the tests
pass, uploaded over FTPS by `.github/workflows/deploy.yml`.

## Landlord and tenant areas

| Route | What it does |
|---|---|
| `GET/POST /join` | Join with an invite code after the phone-code login (`/login?next=/join`) |
| `GET /landlord` | Landlord dashboard: units, running contracts, deadlines, payments, needs action |
| `GET /landlord/contracts/:id` | One contract; `POST .../decision` saves renew / not renew / undecided |
| `POST /landlord/contracts/:id/payments/:pid/confirm` or `/reject` | Answer a tenant's "I paid" |
| `GET /tenant` | Tenant dashboard: contract, countdown, decision deadline, payments |
| `POST /tenant/contracts/:id/payments/:pid/report` | "I paid": the installment becomes `tenant_reported`, never `paid` |
| `POST /tenant/contracts/:id/requests` | Rent-reduction request, only while the engine allows it |
| `POST /office/contracts/:id/payments/:pid/confirm` or `/reject` | The office answers a reported payment |
| `POST /office/contracts/:id/requests/:rid` | The office accepts or rejects a tenant request |

No new environment variables.

## Reminders and notifications

| Route | What it does |
|---|---|
| `GET /notifications` | Notification center (all roles): filter by kind, 20 per page |
| `POST /notifications/:id/read`, `/:id/open`, `/read-all` | Mark read (only your own notifications) |
| `GET/POST /settings/notifications` | Channels, quiet hours, email, WhatsApp number (login phone or SMS code), Telegram link code |
| `GET /office/settings/reminders` | Reminder rules, WhatsApp / Telegram settings (secrets write-only), test message (owner, manager) |
| `POST /webhooks/telegram/:secret` | Telegram bot updates (random per-office secret) |
| `POST /cron/run/:job` | Run a job now; header `X-Cron-Secret: $CRON_SECRET`; answers `{ ok, processed }` |

Environment:

| Variable | Meaning |
|---|---|
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | Email reminders. Without `SMTP_HOST` or `MAIL_FROM` emails are skipped. (`SMTP_PASSWORD` / `SMTP_FROM` still work.) |
| `RUN_CRON` | `false` turns the in-process scheduler off (use cPanel Cron Jobs instead) |
| `CRON_SECRET` | Required by `POST /cron/run/:job` (and `/health/detail`) |

WhatsApp (Meta Cloud API, template messages) and Telegram (Bot API) settings are entered per office in the app and stored encrypted with `SECRET_BOX_KEY`.

cPanel Cron Jobs fallback (with `RUN_CRON=false`):

```
*/5 * * * * curl -s -X POST -H "X-Cron-Secret: YOUR_CRON_SECRET" https://yourdomain.sa/cron/run/deliver
0 4 * * * curl -s -X POST -H "X-Cron-Secret: YOUR_CRON_SECRET" https://yourdomain.sa/cron/run/reminders
```

Jobs: reminders, deliver, recompute, late_payments, digest, expire_invites, trial_check, plan_renewal, purge_notifications, purge_auth (plus disabled placeholders: backup, sms_balance, health_ping, reports).

## Maintenance, payments, messages, team, tasks, reports

| Route | What it does |
|---|---|
| `GET /office/maintenance`, `/:id` | Office board: filters, status flow (new, seen, in_progress, done, rejected), assign, internal notes, public replies |
| `POST /office/maintenance/:id/status`, `/assign`, `/messages` | Office actions |
| `GET /tenant/maintenance`, `POST /tenant/contracts/:id/maintenance` | Tenant request (category, 500 chars, priority, up to 3 photos, multipart) |
| `GET /landlord/maintenance`, `/:id`, `POST /landlord/maintenance/:id/messages` | Landlord follows requests on their units and may comment |
| `GET /maintenance/photos/:id` | Authenticated photo route (ownership checked, 404 otherwise) |
| `GET /office/payments`, `/office/payments.csv` | Overdue list with filters and CSV |
| `POST /office/contracts/:id/payments/:pid/entries`, `/entries/:eid/undo` | Record a (partial) payment; undo within 24 h with a reason |
| `POST /landlord/contracts/:id/payments/:pid/entries`, `/entries/:eid/undo` | Same for the landlord (undo only their own) |
| `GET /office\|landlord\|tenant/contracts/:id/receipt` | Printable payment statement of a contract |
| `GET /office\|landlord\|tenant/messages`, `/messages/:contractId` | Per-contract thread; `POST` sends (10/min), `/delete` (author, 5 min), office `/mute` |
| `GET /office/team`, `POST /office/team/invite`, `/invites/:id/revoke`, `/:memberId/role\|deactivate\|activate` | Staff invites by phone, roles, deactivation (owner and managers) |
| `GET /office/tasks`, `/:id`, `POST /office/tasks`, `/:id`, `/:id/status`, `/:id/comments` | Internal Kanban tasks |
| `GET /office/reports`, `/office/reports/csv/:name` | Reports (occupancy, expiring, overdue, collections, maintenance, workload) and CSV |
| `GET /landlord/statement`, `/landlord/statement/csv` | Landlord's read-only statement |

Storage: maintenance photos are re-encoded with sharp (JPEG, at most 1600 px, no metadata) and stored in `UPLOAD_DIR` (default `storage/uploads` in the app folder). It must be outside the public folder and writable by the app; back it up with the database. See `deploy/DEPLOY-CPANEL.md` step 12. `plans.max_photos` limits photos per office; `plans.max_members` limits active team members.

CSV: UTF-8 with BOM, cells starting with `= + - @` get a leading quote, 10 downloads per minute per person.

## Subscriptions, payments, invoices and the platform admin

Plans, the subscription lifecycle, checkout (Moyasar **test mode only**, or bank transfer), promo codes, invoices and the `/admin` area.

| Route | What it does |
|---|---|
| `GET /office/billing` | Owner only: current plan and state, usage against the limits, plans to buy, open bank transfers, invoices |
| `GET /office/billing/checkout?plan=&interval=&promo=` | Review: price, discount, VAT and total before paying; promo code and interval switch |
| `POST /office/billing/orders` | Creates the order (quote, promo reservation, downgrade check in one transaction) |
| `GET /office/billing/orders/:id/pay` | Moyasar hosted form (this page has its own Content-Security-Policy) |
| `GET /office/billing/moyasar/callback` | The customer's return: the payment is fetched from Moyasar by id; the URL's status is ignored |
| `POST /webhooks/moyasar` | Webhook: wrong or missing `secret_token` answers 404; only the payment id is used and the payment is fetched; replays are no-ops |
| `GET\|POST /office/billing/orders/:id/transfer`, `GET /office/billing/receipts/:id` | Bank transfer: reference (never an IBAN or a long number) and an optional receipt image (re-encoded, owner and platform admin only) |
| `GET /office/billing/invoices/:id` | Printable A4 invoice or receipt (ownership checked, 404 otherwise) |
| `/admin` | Platform admin (2FA, every change needs a reason and writes an audit row): overview, offices (extend trial, change plan, suspend, unsuspend, notes), orders and payments, credit notes, bank-transfer queue, promo codes, plans, settings and kill switches, audit viewer |

**Environment (Moyasar, test mode only).** `MOYASAR_SECRET_KEY`, `MOYASAR_PUBLISHABLE_KEY` and `MOYASAR_WEBHOOK_SECRET` come from the environment only. Without the first two the payment UI says "الدفع الإلكتروني غير مفعّل" and bank transfer still works. Live keys are refused unless `MOYASAR_ALLOW_LIVE=1` (do not set it yet). Card data never touches this app: the customer types it into Moyasar's hosted form; we keep only the payment id, status, amount in halalas and the last 4 digits when Moyasar returns them. Webhook URL to enter in Moyasar: `<APP_URL>/webhooks/moyasar`, with `MOYASAR_WEBHOOK_SECRET` as the secret token. The API shapes used (payment fetch, form settings, webhook body) are written from Moyasar's public documentation and must be verified once in test mode before launch.

**Money.** VAT lives in `config/billing.js` (15%). Prices are stored VAT-exclusive; everything is integer halalas; VAT is rounded half up once on the discounted net. Order of math: subtotal, minus discount, VAT on the net, total.

**Lifecycle.** A new office gets a trial (14 days) and a `trialing` subscription row. A paid period that ends gives 7 days of read-only access ("وضع القراءة فقط"), then the office is suspended; data is kept 90 days (a policy; nothing is deleted automatically). An expired trial is locked at once (as before). Renewing while the same plan runs starts the new period where the old one ends; a plan change or a lapsed plan starts from the payment day. A downgrade is refused while usage is above the new limits (the message lists what to reduce; nothing is deleted). Plan changes in `/admin/plans` apply to subscribers at once.

**Cron.** `plan_renewal` (daily 06:00 Riyadh, also `POST /cron/run/plan_renewal`): moves statuses, reminds the owner 7, 3 and 1 days before the last day (trials too), and expires unpaid orders (24 h for cards, 72 h for transfers that were never sent), freeing their promo reservations. Idempotent (dedupe keys), notifications go through the notification service.

**Invoices.** Gap-free numbers per series and Riyadh year (`INV-2026-000001`, credit notes `CN-2026-000001`) from a locked counter row. Each invoice is a snapshot (seller, buyer = office display name only, lines, discount, VAT, total). The title is "فاتورة ضريبية مبسطة" only when the seller VAT number is set in `/admin/settings`; otherwise "إيصال دفع". The refund action issues a credit note; it does not move money.

**Invoicing entity pending, ZATCA later.** The company that issues invoices is not decided yet: legal name, VAT number, address and CR are empty-safe platform settings (platform admin only) and no company or VAT number is hardcoded. This app does not claim ZATCA e-invoicing compliance; ZATCA Phase 2 integration is a separate later task.

**Plan features.** `plans.features` holds on/off switches (`whatsapp`, `telegram`, `reports_csv`, `ai_reading`); a missing key, null or the older array form means allowed. They are enforced on the server (AI reading, CSV downloads, WhatsApp/Telegram settings and delivery). `max_members` is the "max staff" limit.

**Kill switches** (`/admin/settings`): disable signups (existing users keep signing in), disable AI reading, and a banner message shown on every page.

## Public listings, marketing site and blog

| Route | What it does |
|---|---|
| `GET /`, `/features`, `/pricing`, `/about`, `/privacy`, `/terms`, `/disclaimer` | Marketing pages (pricing is read from the plans table) |
| `GET/POST /contact` | Contact form, stored for the platform admin (5 per IP per hour) |
| `GET /listings`, `/listings/:id` | Public search (12 per page) and detail; expired, rented or hidden answer 410, drafts 404 |
| `POST /listings/:id/inquiry`, `GET/POST /listings/:id/report` | Inquiry (honeypot, 5 per IP and 10 per listing per hour) and abuse report |
| `GET /listings/photos/:id/:variant` | Listing photo (`full` or `thumb`), only while the listing is public |
| `GET /blog`, `/blog/:slug`, `/blog/:slug/cover`, `/blog/feed.xml` | Blog and RSS |
| `GET /sitemap.xml`, `/robots.txt` | SEO (private areas are disallowed) |
| `/office/listings...` | Office side: create from a vacant unit, edit, photos, publish, hide, renew, inquiries (plan feature `listings`, limit `max_listings`) |
| `/admin/reports`, `/admin/messages`, `/admin/blog`, `POST /admin/settings/analytics` | Platform admin: abuse queue, contact messages, blog CRUD, optional analytics tag |

Public pages show type, city, neighborhood (fixed list), rooms, area, annual rent, features, photos and the office name only.
Listings hide themselves 60 days after publishing (jobs `listings_expiry`, `purge_inquiries`). Seed the default plans, FAQs and three draft blog posts once with `node database/seed.js`.
No new environment variables. The final audit is in [`docs/AUDIT.md`](docs/AUDIT.md); the full deployment reference and pre-launch checklist in [`DEPLOY.md`](DEPLOY.md).

## Project layout

| Path | Purpose |
|---|---|
| `server.js` | Startup file (Passenger/cPanel): runs the self-check, then listens |
| `app.js` | Express app: security headers, parsers, static files, maintenance guard, routes, error handlers |
| `config/db.js` | MySQL pool and `ensureSchema()`, run at startup |
| `database/` | `schema.js` (all tables, in creation order) and `seed.js` (default rows) |
| `routes/` | HTTP routes |
| `middleware/` | Auth, permissions, maintenance guard, security headers, 404 and error handlers |
| `services/` | Business logic: auth, OTP, TOTP, SMS drivers, self-check, office scoping, audit |
| `deploy/` | cPanel guide (Arabic) and `restart.js` (`npm run restart`) |
| `utils/` | Logger and time helpers |
| `views/` | EJS layout, partials, pages and error pages |
| `public/` | Static CSS/JS served with fingerprinted URLs |
| `tests/` | `node --test` test files |
| `reference/` | Schema and security tests from an earlier prototype, for reference only |

## Blueprint

The project rules, roles, stack constraints and the fixed list of table names
live in [`CLAUDE.md`](CLAUDE.md). Read it before making changes.
