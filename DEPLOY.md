# Deploying Aqdi (عقدي) to cPanel: final guide

The Arabic step-by-step walk-through for non-technical people is
[`deploy/DEPLOY-CPANEL.md`](deploy/DEPLOY-CPANEL.md). This file is the
complete technical reference and the pre-launch checklist. The app runs on
shared cPanel hosting where `npm install` is **not** re-run on deploy: the 13
dependencies in `package.json` are fixed and no new one may be added.

## 1. How the code reaches the server

Two supported ways. Use one.

**A. cPanel "Git Version Control" (pull from GitHub inside cPanel)**

1. cPanel > Git Version Control > Create > clone URL of the repository, branch `main`.
2. `.cpanel.yml` (in the repository) rsyncs the code to the application root and
   touches `tmp/restart.txt`. It never deletes `.env`, `uploads/` or `backups/`
   and skips `tests/`, `reference/` and `*.md`. Change `DEPLOYPATH` in it to your
   application root first.
3. Each time: Git Version Control > Update from Remote > Deploy HEAD Commit.

**B. GitHub Actions over FTPS** (`.github/workflows/deploy.yml`): a push to
`main` runs the tests and, if they pass, uploads the files.

`node_modules/` is installed once with *Setup Node.js App > Run NPM Install*
(Node 20). After a deploy that changes `package.json` this must be done by hand;
this project never changes it.

## 2. Application setup (Setup Node.js App)

| Field | Value |
|---|---|
| Node.js version | 20 |
| Application mode | **Production** (only once a real SMS provider is set, see §4) |
| Application root | the folder in `.cpanel.yml` (`DEPLOYPATH`) |
| Application URL | your domain |
| Startup file | `server.js` |

Environment variables are entered in the same screen (or in `.env` in the
application root). `.env` is never committed.

## 3. Environment variables

| Variable | Required | Where it comes from / what it is |
|---|---|---|
| `NODE_ENV` | yes | `production` |
| `APP_URL` | yes | `https://your-domain` with no trailing slash (canonical URLs, sitemap, RSS, JSON-LD, emails) |
| `PORT` | no | set by Passenger |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | yes | cPanel > MySQL Databases |
| `JWT_SECRET` | yes | 64+ random characters (`openssl rand -hex 48`) |
| `SECRET_BOX_KEY` | yes | exactly 64 hex characters (`openssl rand -hex 32`); encrypts channel credentials, TOTP secrets |
| `CRON_SECRET` | yes | long random string; `X-Cron-Secret` header for `/cron/run/*` and `/health/detail` |
| `PLATFORM_ADMIN_PHONE` | yes | your Saudi mobile; signing in with it gives the platform_admin role |
| `REQUIRE_ADMIN_2FA` | **leave unset** | testing only; ignored in production and flagged by the self-check |
| `RUN_CRON` | no | `false` when cPanel Cron Jobs call the URLs instead of the built-in scheduler |
| `BACKUP_DIR` | recommended | absolute folder for the encrypted backups, **outside** `public/`, e.g. `/home/USER/aqdi_backups` (empty = `./backups` in the application root, ignored by git and by the deploy rsync). Created with mode `0700` |
| `BACKUP_WEBHOOK_URL` | optional | `https://...` monitor that receives `{ ok, size, sha256, filename, at }` after each backup (never the file) |
| `HEALTHCHECK_PING_URL` | optional | `https://...` uptime-monitor heartbeat, fetched after every healthy 15-minute check |
| `SMS_BALANCE_WARN` | optional | warn the platform admin below this SMS balance (default 100) |
| `UPLOAD_DIR` | yes | absolute path **outside** `public/`, writable by the app, e.g. `/home/USER/aqdi_uploads` |
| `SMS_PROVIDER`, `SMS_API_KEY`, `SMS_SENDER`, `SMS_USERNAME` | yes (production) | `unifonic` or `msegat`; `console` is refused in production |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | optional | email reminders; empty = email skipped |
| `CLAUDE_API_KEY`, `CLAUDE_MODEL` | optional | AI contract reading; empty = feature off |
| `MOYASAR_SECRET_KEY`, `MOYASAR_PUBLISHABLE_KEY`, `MOYASAR_WEBHOOK_SECRET` | optional | card payments, **test keys only** until the commercial entity is decided (`MOYASAR_ALLOW_LIVE=1` is the explicit opt-in for live keys) |
| `TEST_DB_NAME` | never on the server | separate empty database for `npm test` on a developer machine |

WhatsApp and Telegram credentials are **not** environment variables: each office
enters its own in the app and they are stored encrypted with `SECRET_BOX_KEY`.
The optional analytics tag is a platform setting (Admin > Settings), empty by
default, not an environment variable.

## 4. First start

1. Start the app. `ensureSchema()` creates every table (73) and applies the
   additive migrations on its own; there is nothing to run by hand.
2. Seed the default rows once (plans, message templates, settings, FAQs and
   three **draft** blog posts flagged "needs review before publishing"). From the
   cPanel terminal, in the application root: `node database/seed.js`. It is
   idempotent.
3. Open `https://your-domain/health`: `status: ok`, `database: reachable`.
4. Check the detail (the same value as `CRON_SECRET`):
   `curl -H "X-Cron-Secret: ..." https://your-domain/health/detail`
   shows `live.schema.found == live.schema.total` (73/73), the client IP the app
   sees (it must not be 127.0.0.1 for every visitor) and every startup warning.
5. Sign in with `PLATFORM_ADMIN_PHONE`, set up the authenticator app (2FA) and
   **save the backup codes** (shown once).
6. SMS: Production mode never uses the console driver. Set `SMS_PROVIDER` and its
   key **before** switching Application mode to Production, or nobody can sign in.

## 5. Scheduled jobs

The built-in scheduler (node-cron, Asia/Riyadh) runs unless `RUN_CRON=false`.
On hosting where Passenger stops an idle app, set `RUN_CRON=false` and add these
in cPanel > Cron Jobs (replace the URL and the secret). Each call answers only
`{ ok, processed }`; each run holds a database lock so a job never overlaps itself.

```
# every 5 minutes: send queued messages
*/5 * * * *  curl -s -X POST -H "X-Cron-Secret: SECRET" https://your-domain/cron/run/deliver >/dev/null
# hourly: hide expired listings and remind owners 7 days ahead
40 * * * *   curl -s -X POST -H "X-Cron-Secret: SECRET" https://your-domain/cron/run/listings_expiry >/dev/null
# hourly: remove stale invite codes
15 * * * *   curl -s -X POST -H "X-Cron-Secret: SECRET" https://your-domain/cron/run/expire_invites >/dev/null
# every 10 minutes: purge expired login codes and sessions
*/10 * * * * curl -s -X POST -H "X-Cron-Secret: SECRET" https://your-domain/cron/run/purge_auth >/dev/null
# daily (server time is whatever cPanel uses; the jobs compute Riyadh dates themselves)
10 0 * * *   ... /cron/run/recompute            # contract stages
20 0 * * *   ... /cron/run/late_payments        # overdue installments
30 3 * * *   ... /cron/run/purge_inquiries      # listing inquiries older than 90 days
0 6 * * *    ... /cron/run/plan_renewal         # subscriptions: reminders, grace, suspension
0 7 * * *    ... /cron/run/reminders            # contract and payment reminders
0 8 * * *    ... /cron/run/digest               # office daily summary
30 9 * * *   ... /cron/run/trial_check          # trial ending
# operations
*/15 * * * * ... /cron/run/health_ping          # health check, alerts to the platform admin
0 2 * * *    ... /cron/run/backup               # encrypted database backup (see section 6b)
0 10 * * *   ... /cron/run/sms_balance          # SMS balance, warns below SMS_BALANCE_WARN
0 5 1 * *    ... /cron/run/reports              # monthly platform summary (the 1st)
# weekly
0 3 * * 5    ... /cron/run/purge_notifications  # notifications 180 days, delivery log 90 days
```

cPanel cron uses the **server's** clock: set the hours above to Riyadh time (the built-in scheduler always uses Asia/Riyadh). A run that finds the job already running (for example the built-in scheduler and a cron line together) does nothing: `{ "ok": true, "processed": 0 }`.

## 6. Uploads directory

`UPLOAD_DIR` holds maintenance photos, listing photos (full and thumbnail),
blog covers and bank-transfer receipts, all re-encoded to JPEG without
metadata under random file names. Requirements:

- outside `public/` (the app refuses to start the upload code otherwise);
- owned by the app's user, mode `0750` (`chmod 750`), not listed by the web server;
- included in backups (it is not in the database);
- never served directly. Everything goes through routes that check access:
  `/maintenance/photos/:id`, `/listings/photos/:id/:variant` (only while the
  listing is public), `/blog/:slug/cover`, `/office/billing/receipts/:id`.

## 6b. Backups, restore and the restore drill

**What it does.** Job `backup` (daily 02:00 Riyadh) writes one file `aqdi-YYYYMMDD-HHmm.sql.gz.enc` into `BACKUP_DIR`: every table, one consistent snapshot, gzip, then AES-256-GCM with `SECRET_BOX_KEY`. It is built in Node (no `mysqldump` is needed or used), so it works on shared hosting. The plaintext SQL is never written to disk. Kept: the newest backup of each of the last 14 days, 8 Sundays and 6 months; older ones are deleted; the newest is never deleted. A failed backup notifies the platform admin (one notification a day) and shows in Admin > "التشغيل والنسخ الاحتياطي" (`/admin/ops`) with its error code.

**The key is part of the backup.** A backup can only be opened with the same `SECRET_BOX_KEY`. Keep a copy of the key **separately from the backups** (a password manager). Rotating the key makes older backups unreadable: do it before launch, then keep the old key with the old files.

**BACKUP_DIR on cPanel.**
1. Create the folder **outside** `public_html` and outside any folder the web server publishes, e.g. `/home/USER/aqdi_backups`.
2. `chmod 700 /home/USER/aqdi_backups` (the app does this itself on first run; check it in File Manager > Permissions: 0700, owner = your account).
3. Put the path in `BACKUP_DIR`. Make sure the disk quota has room for about 28 files of the database size.
4. Files are created with mode `0600`.

**Download decision.** Backups hold personal data (phones, nicknames), so **the app offers no download button** and no download route. You download them yourself: cPanel > File Manager > `aqdi_backups` > select the file > Download. Do this **weekly to a machine that is not the server** (a laptop with an encrypted disk, or a separate storage account); a backup that lives only on the server is lost with the server. Verify the file: the sha256 in `/admin/ops` must equal `sha256sum aqdi-....sql.gz.enc` of the downloaded file.

**Run one now.** `/admin/ops` > "نسخة احتياطية الآن" (needs a reason; 3 per hour), or from cPanel Terminal: `curl -s -X POST -H "X-Cron-Secret: SECRET" https://your-domain/cron/run/backup`.

**Restore, step by step** (cPanel Terminal, or a laptop with the code, Node 20 and access to a MySQL):
1. Get the file: `ls -l /home/USER/aqdi_backups` (or upload the downloaded file to the machine).
2. Export the same settings the app uses (or have them in `.env`): `DB_HOST`, `DB_USER`, `DB_PASSWORD` and the **same `SECRET_BOX_KEY`** that was active when the backup was made. `DB_NAME` stays the live database name; it is only used as a safety check.
3. Restore into a **new, empty database** first (create it in cPanel > MySQL Databases and give your user all privileges on it):
   `cd /home/USER/aqdi && node scripts/restore-backup.js --file /home/USER/aqdi_backups/aqdi-20261007-0200.sql.gz.enc --target USER_aqdi_restore`
4. Read the output. It checks the sha256 (from the `backups` table, or pass `--sha <value from /admin/ops>`), decrypts and verifies the whole file **before touching anything**, restores, then compares every table's row count with the file. `OK: every table matches.` and exit code 0 means the restore is good. Any other result (`REFUSED (sha_mismatch)`, `bad_key_or_corrupt`, `truncated`, `count_mismatch`, `production_refused`, `target_not_empty`) means: do not use this file or target; try an older backup or check the key.
5. Look at the data (cPanel > phpMyAdmin on the restored database): a few offices, contracts, the newest rows.
6. **Putting it live (disaster only).** Stop the app (Setup Node.js App > Stop). Then either point `DB_NAME` at the restored database and restart, or restore over the live name: `... --target LIVE_DB_NAME --i-know-this-overwrites-production` (this drops and recreates the tables of the live database; use only when it is already lost or damaged). Start the app and check `/health`, `/health/detail` (73/73 tables) and sign in.
7. Everything written after the backup's time (up to a day) is lost: tell offices to re-check the last day, and note that notifications for that day may be sent again or missed.

**Quarterly restore drill** (put it in your calendar; a backup that was never restored is a hope, not a backup):
- [ ] Download the newest backup to a separate machine and compare its sha256 with `/admin/ops`.
- [ ] Restore it into a scratch database with `scripts/restore-backup.js` (step 3) using the **production key from the password manager**, not the one in the server's `.env` by habit.
- [ ] Output ends with `OK: every table matches` and exit code 0.
- [ ] Open the scratch copy: counts of offices, contracts and users look right; the newest rows are from last night.
- [ ] Time it, write down how long the restore took and the size of the file.
- [ ] Try a damaged copy (change one byte) and confirm it is refused.
- [ ] Drop the scratch database; delete the downloaded copy if it is on a shared machine.
- [ ] Check retention: `/admin/ops` shows about 14 recent days plus Sundays and month starts, and no failed backups in the last week.

**Monitoring.** `GET /healthz` answers `{"ok":true}` and nothing else: point an uptime monitor at it. Set `HEALTHCHECK_PING_URL` for a heartbeat (dead-man's-switch) service, and `BACKUP_WEBHOOK_URL` to be told after every backup. The health check (every 15 minutes) alerts the platform admin, once per problem per day, when: the database is unreachable, the scheduled jobs stopped (30 min), the last good backup is older than 36 hours, disk space of `BACKUP_DIR` or `UPLOAD_DIR` is below 200 MB, the message queue is stuck, many messages failed in the last hour, or a suspicious payment waits. It sends an "all clear" when a problem goes away. The SMS balance is checked daily (Unifonic and Msegat; the request shapes follow their public documentation and should be checked once with your real account).

## 7. SSL and Cloudflare

- Install the SSL certificate (cPanel > SSL/TLS Status > AutoSSL) and force HTTPS
  (cPanel > Domains > Force HTTPS Redirect). Session cookies are `Secure` in production and HSTS is sent by the app.
- If the domain is behind Cloudflare: SSL mode **Full (strict)**; leave
  *Rocket Loader*, *Auto Minify* and *Email Obfuscation* **off** (they rewrite
  HTML/JS and break the Content-Security-Policy); keep "Always Use HTTPS" on.
- `/listings/photos/*` answers `Cache-Control: public, max-age=86400` with an ETag:
  Cloudflare may cache it. **Never** cache `/office`, `/admin`, `/landlord`,
  `/tenant`, `/login`, `/join`, `/notifications`, `/settings` (they send
  `no-store`; a "cache everything" page rule must exclude them).
- The app trusts the loopback proxy only: the visitor's address is the right-most
  `X-Forwarded-For` entry added by the web server. Check `/health/detail > request.yourIp`.
- Moyasar webhook URL: `https://your-domain/webhooks/moyasar` (secret token = `MOYASAR_WEBHOOK_SECRET`). Telegram webhooks are registered by the app per office.

## 8. Pre-launch checklist

The live version of this list is **Admin > جاهزية الإطلاق** (`/admin/launch`): 19 checks with pass / warn / fail, no secret ever shown. Items the app cannot see (secrets and DB password rotated, backup codes regenerated, restore drill, Ejar rules verified, lawyer review, last `npm audit`) are recorded there by hand with a reason. In production the app also logs the ids of failing checks at start-up. Open it before opening the platform to real users and keep going until nothing is red.

Do every item, in this order. Tick it in your copy.

- [ ] Create a **new** database user and password for production; never reuse a development value. Rotate `DB_PASSWORD`.
- [ ] Generate **new** `JWT_SECRET`, `SECRET_BOX_KEY` and `CRON_SECRET`. (Changing `JWT_SECRET` signs everyone out; changing `SECRET_BOX_KEY` after offices saved WhatsApp/Telegram settings or admins enabled 2FA makes those unreadable: do it **before** launch, not after.)
- [ ] Platform admin: sign in, enable 2FA, and **regenerate the 2FA backup codes**; store them offline.
- [ ] `REQUIRE_ADMIN_2FA` is **not set** in the environment (the self-check reports it otherwise).
- [ ] `SMS_PROVIDER` is a real provider with a sender name; send yourself a login code; only then set Application mode to Production.
- [ ] **Verify every rule in `config/ejarRules.js` against the official Ejar / REGA source** (60-day non-renewal notice, 90-day rent-change notice, auto-renew default, the Riyadh rent freeze dates, the 30/7-day stages). The numbers are placeholders until a person confirms them.
- [ ] Admin > Settings: fill the seller details (legal name, commercial register, VAT number if registered, address), bank details for transfers, support phone and email. Invoices say "إيصال دفع" until a VAT number is set; nothing is hard-coded.
- [ ] **Legal review** of `/privacy`, `/terms` and `/disclaimer` by a lawyer (each page says so until reviewed). Then edit the text and remove the notice.
- [ ] Review the three seeded blog drafts (Admin > Blog); publish, edit or delete them. They are marked "يحتاج مراجعة قبل النشر".
- [ ] Plans: check names, prices (VAT-exclusive), limits and the `listings` / `whatsapp` / `telegram` / `reports_csv` / `ai_reading` switches in Admin > Plans.
- [ ] Moyasar stays in TEST mode until the commercial entity is decided; bank transfer works without it.
- [ ] Backups: set `BACKUP_DIR` (outside `public_html`, mode 0700), run one backup from `/admin/ops`, download it through File Manager to another machine, keep `SECRET_BOX_KEY` in a password manager **apart from the backups**, and do the restore drill of section 6b once before launch. Also copy `UPLOAD_DIR` (photos and receipts are not in the database dump). cPanel's own account backup is a good second layer.
- [ ] Monitoring: an external uptime check on `https://your-domain/healthz` (every 1-5 minutes) with an alert to your phone; optionally `HEALTHCHECK_PING_URL` and `BACKUP_WEBHOOK_URL`; read `/health/detail` after every deploy and `/admin/ops` weekly.
- [ ] `robots.txt` and `sitemap.xml` open and correct; submit the sitemap in Google Search Console.
- [ ] Open the site on a phone: home, pricing, a listing, register, create an office, sign out, sign in.
- [ ] Run `npm test` against a **throwaway** database (never the real one) and `npm audit --omit=dev` before the release commit.

## 9. Rollback

The deploy only copies files; the database changes made by `ensureSchema()` are
**additive** (new tables, columns, indexes), so an older version of the code runs
on the newer schema.

1. cPanel > Git Version Control > the repository > History (or `git log`): note the last good commit.
2. Check it out and deploy it: either `git revert <bad commit>` on `main` and deploy, or on the server `git reset --hard <good commit>` then Deploy HEAD Commit. (Reverting keeps history; prefer it.)
3. Touch `tmp/restart.txt` (or *Restart* in Setup Node.js App) and check `/health` and `/health/detail`.
4. If a migration itself was the problem, restore the database backup taken before the deploy (section 6b); take one from `/admin/ops` before every deploy that adds tables.
5. Uploads are never touched by a deploy; no action needed.
6. If something is badly wrong and you need time: Admin > Settings > banner message, or turn off sign-ups / AI reading with the kill switches. They are memory-refreshed within 30 seconds.

## 10. After launch

- Watch Admin > Reports (abuse reports on public listings) and Admin > Messages (contact form) daily at first.
- Public listings expire after 60 days (owner reminded 7 days before); inquiries are deleted after 90 days.
- `docs/AUDIT.md` lists what was tested in the final audit and the open risks.
