# Final audit (Prompt 15)

Scope: public listings, marketing site and blog, then a whole-product review of
privacy, security, tenant isolation and the main user journey. Everything below
is covered by tests that run in `npm test` (`tests/audit*.test.js` plus the
listing and site tests), against a throwaway local MariaDB. Nothing here was run
against a real or production database.

Result of the last full run: **all tests pass** (see the commit message for the
exact count). `npm audit --omit=dev`: **found 0 vulnerabilities**, no upgrades made. The 13 dependencies are unchanged.

## 1. Privacy

| Check | How | Result |
|---|---|---|
| No column can hold a national ID, iqama, IBAN, meter or account number, party name or address | `auditPrivacy`: every column in `information_schema` and in the table definitions against a forbidden pattern | pass |
| Every column with "name" in it is reviewed | exact allowlist of 11 columns (office, building, plan, vendor, invoice buyer = office name, public form senders, the user's own display name, testimonial author, job id) | pass; a new "name" column fails the test until reviewed |
| Public pages never show private fields | `publicSite`, `listingsFlow`, `auditE2E`: the public listing page, JSON-LD, sitemap and RSS are scanned for the unit label, building, landlord, notes, phone numbers | pass |
| Photos carry no EXIF/GPS | `listingsFlow`: a JPEG with an embedded marker is uploaded; the stored file and the thumbnail are read back and contain no metadata | pass |
| AI contract reading stores nothing personal | `auditE2E`: the mocked model answers with a tenant name, landlord name, address, meter number, IBAN, national ID and iqama; none appears in the form, in any table (every table is dumped and searched) or in the log; the uploaded file is not on disk | pass |
| Logs hold no full phone number, token, secret or login code | `auditE2E` captures everything logged during the end-to-end run and matches phone, JWT, `123456`, and the values of JWT_SECRET, SECRET_BOX_KEY, CRON_SECRET, DB_PASSWORD, CLAUDE_API_KEY | pass |
| No log statement interpolates risky data | `auditPrivacy` scans every `logger.*`/`console.*` call in the source for phone, token, secret, password, otp, code, body, message, text, note, reference | pass (error `.code/.message/.name` fields are allowed: system text) |
| Production never prints login codes | `auditPrivacy`: `SMS_PROVIDER=console` is refused when `NODE_ENV=production` | pass |

Judgement call: the development console SMS driver does print the phone and the
code. It exists for local work only, is refused in production, and the pre-launch
checklist requires a real provider before Production mode.

## 2. Security sweep (`auditSweep`)

| Check | Result |
|---|---|
| Route table (240 routes read from the Express stack): every route that is not public by design answers a visitor with 302 to login, 401, 403 or 404, never 200 or 5xx | pass |
| Tenants and landlords on every `/office`, `/admin`, `/platform` route (all methods): 302 away, 403 or 404 only | pass |
| Office members (owner, staff) on every `/admin` route: refused | pass |
| Staff on owner/manager pages (team, billing, audit, reports, reminder settings): 403/404 | pass |
| Cross-site state change: every POST/PUT/DELETE route (except webhooks and cron) with `Origin: https://evil.example`, as owner and as admin: 403; a foreign `Referer` alone: 403 | pass |
| Headers: CSP `default-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`, no `unsafe-inline`/`unsafe-eval` for scripts, `nosniff`, HSTS, no `X-Powered-By`; private pages `no-store` | pass |
| Cookies: HttpOnly, SameSite=Lax, Secure when `NODE_ENV=production` | pass |
| Rate limits answer 429: OTP request, join code, public inquiry, contact form | pass |
| Path traversal on file routes (`/maintenance/photos`, `/listings/photos`, `/blog/:slug/cover`, static files, receipts, `%2e%2e`, `%2f`, `%5c`, `%00`) as owner, tenant and visitor | pass: never 200, never 5xx, no file content |
| SQL injection payloads (`' OR '1'='1`, `UNION SELECT`, `SLEEP(4)`, `%`, `_`, `\`, arrays) on every search/filter parameter of contracts, landlords, units, payments, listings, tenants, maintenance, audit, public listings and blog, and the admin lists | pass: no 5xx, no SQL error text, no slow query, no extra or deleted rows |
| HTML escaping: `<script>alert(7)</script>` and `<img src=x onerror=...>` stored in office, landlord, unit, building, tenant label, notes, listing title and description, inquiry, abuse report note, contact message, blog title/excerpt/body (including a `javascript:` Markdown link), plan name, audit reason, banner and seller legal name, then 50 pages rendered | pass: no raw payload on any page, no `javascript:` href, escaped form present on 25+ pages |
| Analytics snippet allowlist: inline code, unknown hosts, `javascript:` and event handlers are refused | pass |

## 3. Tenant isolation (`auditIsolation`)

- Every table that has an `office_id` column is either registered in `services/scopeToOffice.js` or on a short reviewed list with the reason (audit trail, notifications and delivery rows filtered by user, global templates, testimonials). A new unreviewed table fails the test.
- Every scoped table that has rows: an office scoped to B can not read (`select`, `selectOne`), update or delete A's rows by id; the owner still sees them. Raw queries that do not pin `:office_id` throw; writes that name another office throw; a child row can not be added under another office's parent.
- Over HTTP, B's owner gets **404** (never 403, never the data) for A's contract (view, edit, terminate, renew, receipt, delete, invite, payments and entries), landlord, unit, listing and task ids, and B's lists never show A's names.

## 4. End-to-end journey (`auditE2E`)

Over real HTTP: a new phone signs in and creates an office, adds a landlord, a building and two units through the forms, creates a contract, the tenant and the landlord join with their codes, the reminder engine creates the 60-day decision reminder for the office, the landlord and the tenant, a payment is tracked and the installment becomes paid, the tenant raises a maintenance request with a photo, a listing is created, filled, given a photo and published, a visitor opens the public page (no private field shown) and sends an inquiry, the owner is notified, the occupancy report downloads as UTF-8 CSV with a BOM, and the office buys a plan by bank transfer, the platform admin approves it, the office is `active` on the new plan and the invoice `INV-YYYY-NNNNNN` opens. **pass**.

## 5. Mobile (375 px)

- Test: every layout has the viewport tag and `dir="rtl"`; no fixed `width`/`min-width` above 375 px outside media queries (the only exception, `.table`, scrolls inside `.table-wrap`).
- Browser check (headless Chromium at 375 px, 21 pages: marketing, listings, blog, office, listings admin, contract, admin pages): the check **found one real bug**: the five status tabs of `/office/listings` made the page 429 px wide. Fixed with `flex-wrap: wrap` on `.tabs` (regression assertion in the test). After the fix no page scrolls sideways.

## 6. Schema self-check

`/health/detail` (with `X-Cron-Secret`) reports `live.schema.found = total = 72` tables, equal to `database/schema.js` and to the list in `CLAUDE.md` (asserted in `auditSweep`).

## 7. Dependencies

`npm audit --omit=dev`: found 0 vulnerabilities. No package was added or upgraded; `package.json` still lists exactly the 13 allowed dependencies.

## 8. Open risks and things only a person can do

These are not code defects; they are on the pre-launch checklist in `DEPLOY.md`.

1. **Ejar/REGA rules** in `config/ejarRules.js` are unverified placeholders until someone checks them against the official sources. Reminder dates depend on them.
2. **Legal text** (`/privacy`, `/terms`, `/disclaimer`) and the three seeded blog drafts need a lawyer's and an editor's review; both say so on the page.
3. **Moyasar** payments are test-mode only; the request/response shapes come from public docs and must be verified once in test mode.
4. **Rate limits are in memory** (per process). On a single Passenger process that is correct; if the host ever runs several processes each has its own counter. Per-IP limits also depend on the web server forwarding `X-Forwarded-For` (check `/health/detail`).
5. **Public listing photos** are served by the app. With Cloudflare in front they can be cached; the owner of a listing that is later hidden may still have its photos cached for up to a day.
6. **Console SMS driver** prints codes; keep `SMS_PROVIDER` set to a real provider in production.
7. **Backups** are a hosting task (not automated by the app); the `backup` job is a registered placeholder.
8. ZATCA e-invoicing is **not** implemented; the invoice page says it is not an approved e-invoice.
