# Project: Aqdi (عقدي)
A Saudi SaaS platform for real-estate offices to manage rental contracts. Six roles on one platform:
platform_admin (me), office_owner (pays), office_manager, office_staff, landlord, tenant.
Offices pay a subscription. Landlords and tenants join free with an invite code.
Contracts are created on the government Ejar platform. This app NEVER connects to Ejar. The office uploads the contract file it downloaded from Ejar, AI reads only dates and amounts, and the app tracks deadlines and sends reminders on four channels.

# Stack (never add a new dependency without asking me first)
Node.js 20 + Express 4 + EJS templates + MySQL (mysql2) + node-cron. No frontend framework, no build step, no ORM.
Exactly these 13 dependencies: express, express-ejs-layouts, ejs, mysql2, dotenv, helmet, cookie-parser, jsonwebtoken, bcryptjs, express-fileupload, nodemailer, node-cron, sharp.
Everything else is written with Node's built-in modules: TOTP with crypto, WhatsApp/Telegram/Moyasar/Claude API with https. Reason: the app runs on shared cPanel hosting where npm install is not re-run on deploy, so a new dependency breaks the deployment.

# Rules you must follow
1. The UI is Arabic, RTL, mobile-first, large text and obvious buttons, for non-technical users. All user-facing text is Arabic; code, comments and commit messages are English.
2. Never add a feature I did not ask for. Simplicity beats cleverness.
3. No Ejar logo, colors or wording that suggests this app is official or governmental. Show where relevant: 'تطبيق خاص غير تابع لمنصة إيجار، والتواريخ للتذكير فقط'.
4. Privacy: never store from a contract the party names, national ID or iqama numbers, IBAN, meter or account numbers, or full addresses. Never log contract contents. Never persist the uploaded contract file.
5. Secrets live only in environment variables or encrypted in the database. .env is gitignored. Never print a secret.
6. Every table that belongs to an office carries office_id, and every query goes through scopeToOffice(). One office must never read another office's row, even through a coding mistake.
7. Dates: store Gregorian (YYYY-MM-DD) and UTC timestamps; display in Asia/Riyadh. Hijri is display-only text. All date math lives in services/contractDates.js, pure functions covered by tests.
8. Money: DECIMAL(12,2) with a separate currency column, SAR by default.
9. Security on the server, never only in the UI: every protected route uses requirePerm. Hiding a button is decoration.
10. After every task: run the tests, fix failures, commit with a clear message, push to main, then tell me in simple Arabic what to check in the browser.

# Office area (routes/office.js, middleware/loadOffice.js)
- Sign-up: /register uses the phone OTP flow. A new phone becomes a user with role NULL; only PLATFORM_ADMIN_PHONE ever becomes platform_admin. Role NULL lands on /office/new, which creates the office in ONE transaction (offices, users.role = office_owner, office_members, office_settings, audit_logs) and is never shown again once the user has a role or any office membership.
- After login: platform_admin -> /platform, office_owner/office_manager/office_staff -> /office, landlord -> /landlord, tenant -> /tenant, no role -> /office/new (services/auth.js homeFor).
- loadOffice runs on every /office route: it takes the office from the signed-in user's ACTIVE office_members row and sets req.office and req.memberRole. Never take an office id from the URL, body or cookie. An inactive member row gets 403. Inside /office, requirePerm checks req.memberRole. The membership lookup by user id (services/offices.js membershipsFor) is the only office-table query not scoped by office, because it is how the office id is found.
- Status rules (services/offices.js officeAccess): trial (not expired) and active = full access; past_due = access plus a red banner; suspended or an expired trial (trial_ends_at in UTC) = every /office page except /office/billing and /office/settings shows "اشتراكك منتهي" (HTTP 402). Trial days left are counted on the Riyadh calendar.
- Routes and capabilities: /office (contracts), /office/contracts (contracts), /office/units (units), /office/tenants (tenants), /office/payments (payments.read), /office/maintenance (maintenance), /office/listings (listings), /office/reports (reports), /office/messages (messages), /office/team (team), /office/audit (audit), /office/settings GET (settings.basic) and POST (settings.office), /office/billing (billing). The sidebar shows an item only when the role has its capability.

# Landlords and invites (routes/landlords.js, services/landlords.js, services/invites.js)
- Routes (all 'landlords' unless noted): GET /office/landlords (list: search q, status joined|invited|not_invited, 20 per page), GET /office/landlords/new, POST /office/landlords, GET /office/landlords/:id, GET /office/landlords/:id/edit, POST /office/landlords/:id (edit), POST /office/landlords/:id/deactivate, POST /office/landlords/:id/activate, POST /office/landlords/:id/delete ('contracts.delete'), POST /office/landlords/:id/invite (create or regenerate, max 20 per office per hour), POST /office/landlords/:id/invite/revoke.
- A landlord id from the URL is looked up only inside req.office; another office's id (or a malformed id) answers 404, never 403.
- A landlord is a nickname, city, mobile and notes only. Never add ID, iqama, IBAN or address fields. Audit rows hold label, city and is_active, and only the names of other changed fields (never the phone or the notes text).
- Deactivate is soft. Delete only when the landlord has no units, buildings or contracts (checked in the DELETE statement itself).
- Invites: 8-character code from services/inviteCode.js, expires 30 days after creation (contractDates.inviteExpiresAt). invites.revoked_at (added by ensureSchema if missing) marks a revoked or replaced code. One active (unused, unrevoked, unexpired) landlord invite per landlord: creating one revokes the previous, under a row lock on the landlord. Inactive or already-joined landlords get no invite. Audit rows never contain the code.
- Join side: validateInviteCode(pool, code) returns { ok, invite } or { ok: false, reason } with reason not_found | expired | used | revoked (malformed input is not_found; codes are trimmed, upper-cased, spaces and dashes removed; 0 O 1 I L are rejected). Use inviteGuard.check() in the join route: 5 wrong attempts per IP per 15 minutes, 10 per phone per hour. markInviteUsed(pool, code, userId) is one atomic UPDATE; true for exactly one caller. These two look a code up across offices by design (the person joining has no office yet).

# Fixed table names
users, otp_codes, user_sessions, user_devices, notification_prefs, offices, office_members, office_branches, office_settings, office_secrets, landlords, buildings, units, unit_photos, unit_amenities, contracts, contract_members, contract_payments, contract_events, contract_notices, contract_renewals, contract_documents, extraction_jobs, invites, maintenance_requests, maintenance_messages, maintenance_photos, vendors, listings, listing_inquiries, listing_views, plans, subscriptions, subscription_invoices, platform_payments, promo_codes, promo_usages, reminders, notifications, notification_log, message_templates, conversations, messages, tickets, ticket_messages, contact_messages, waitlist, audit_logs, staff_activity, office_tasks, internal_notes, blog_posts, testimonials, faqs, settings, page_views, cron_runs, backups, feature_flags
