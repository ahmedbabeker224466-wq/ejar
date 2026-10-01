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
7. Dates: store Gregorian (YYYY-MM-DD) and UTC timestamps; display in Asia/Riyadh. Hijri is display-only text. All date math lives in services/contractDates.js (date primitives) and services/contractEngine.js (contract rules), pure functions covered by tests.
8. Money: DECIMAL(12,2) with a separate currency column, SAR by default.
9. Security on the server, never only in the UI: every protected route uses requirePerm. Hiding a button is decoration.
10. After every task: run the tests, fix failures, commit with a clear message, push to main, then tell me in simple Arabic what to check in the browser.

# Office area (routes/office.js, middleware/loadOffice.js)
- Sign-up: /register uses the phone OTP flow. A new phone becomes a user with role NULL; only PLATFORM_ADMIN_PHONE ever becomes platform_admin. Role NULL lands on /office/new, which creates the office in ONE transaction (offices, users.role = office_owner, office_members, office_settings, audit_logs) and is never shown again once the user has a role or any office membership.
- After login: platform_admin -> /platform, office_owner/office_manager/office_staff -> /office, landlord -> /landlord, tenant -> /tenant, no role -> /office/new (services/auth.js homeFor).
- loadOffice runs on every /office route: it takes the office from the signed-in user's ACTIVE office_members row and sets req.office and req.memberRole. Never take an office id from the URL, body or cookie. An inactive member row gets 403. Inside /office, requirePerm checks req.memberRole. The membership lookup by user id (services/offices.js membershipsFor) is the only office-table query not scoped by office, because it is how the office id is found.
- Status rules (services/offices.js officeAccess): trial (not expired) and active = full access; past_due = access plus a red banner; suspended or an expired trial (trial_ends_at in UTC) = every /office page except /office/billing and /office/settings shows "اشتراكك منتهي" (HTTP 402). Trial days left are counted on the Riyadh calendar.
- Routes and capabilities: /office (contracts), /office/tenants (tenants), /office/payments (payments.read), /office/maintenance (maintenance), /office/listings (listings), /office/reports (reports), /office/messages (messages), /office/team (team), /office/audit (audit), /office/settings GET (settings.basic) and POST (settings.office), /office/billing (billing). The sidebar shows an item only when the role has its capability.

# Landlords and invites (routes/landlords.js, services/landlords.js, services/invites.js)
- Routes (all 'landlords' unless noted): GET /office/landlords (list: search q, status joined|invited|not_invited, 20 per page), GET /office/landlords/new, POST /office/landlords, GET /office/landlords/:id, GET /office/landlords/:id/edit, POST /office/landlords/:id (edit), POST /office/landlords/:id/deactivate, POST /office/landlords/:id/activate, POST /office/landlords/:id/delete ('contracts.delete'), POST /office/landlords/:id/invite (create or regenerate, max 20 per office per hour), POST /office/landlords/:id/invite/revoke.
- A landlord id from the URL is looked up only inside req.office; another office's id (or a malformed id) answers 404, never 403.
- A landlord is a nickname, city, mobile and notes only. Never add ID, iqama, IBAN or address fields. Audit rows hold label, city and is_active, and only the names of other changed fields (never the phone or the notes text).
- Deactivate is soft. Delete only when the landlord has no units, buildings or contracts (checked in the DELETE statement itself).
- Invites: 8-character code from services/inviteCode.js, expires 30 days after creation (contractDates.inviteExpiresAt). invites.revoked_at (added by ensureSchema if missing) marks a revoked or replaced code. One active (unused, unrevoked, unexpired) landlord invite per landlord: creating one revokes the previous, under a row lock on the landlord. Inactive or already-joined landlords get no invite. Audit rows never contain the code.
- Join side: validateInviteCode(pool, code) returns { ok, invite } or { ok: false, reason } with reason not_found | expired | used | revoked (malformed input is not_found; codes are trimmed, upper-cased, spaces and dashes removed; 0 O 1 I L are rejected). Use inviteGuard.check() in the join route: 5 wrong attempts per IP per 15 minutes, 10 per phone per hour. markInviteUsed(pool, code, userId) is one atomic UPDATE; true for exactly one caller. These two look a code up across offices by design (the person joining has no office yet).

# Buildings and units (routes/units.js, services/buildings.js, services/units.js, services/unitStatus.js, services/planLimits.js)
- Routes (all 'units' unless noted): GET /office/units (tabs: units, ?tab=buildings; search, filters landlord/building/status/type, 20 per page), GET /office/units/new (?landlord= preselects), POST /office/units, GET /office/units/bulk, POST /office/units/bulk (up to 30 units, one transaction), GET /office/units/:id, GET /office/units/:id/edit, POST /office/units/:id (edit, amenities included), POST /office/units/:id/status, POST /office/units/:id/delete ('contracts.delete'), GET /office/units/buildings/new, POST /office/units/buildings, GET /office/units/buildings/:id/edit, POST /office/units/buildings/:id, POST /office/units/buildings/:id/delete ('contracts.delete').
- Another office's unit or building id (or a malformed id) answers 404. A unit's landlord must be this office's (active) landlord; its building must belong to the same landlord. A building's landlord can change only while it has no units (checked in the UPDATE).
- Privacy: buildings and units hold nicknames, city, district and notes only. No street address, plot or deed number, coordinates or meter numbers. Audit rows hold ids, labels, statuses and the names of changed fields, never notes.
- Status: staff switch vacant <-> maintenance by hand; 'rented' is set and cleared only by the contract system through unitStatus.setRented(scoped, unitId) and setVacant(scoped, unitId). setVacant changes only a rented unit.
- Delete: a building only when it has no units; a unit only when not rented and with no contract, maintenance request or listing. Both checks live inside the DELETE statement.
- Plan limits: services/planLimits.js. checkLimit({ limit, current, adding }) is pure (limit NULL = unlimited). Any create that counts against a limit runs in a transaction whose FIRST statement is unitUsage(scoped, { lock: true }): it locks the office row and counts with a locking read, so parallel creates cannot pass the limit. Use the same pattern for contracts and members.
- Amenities are fixed keys (services/units.js AMENITIES) stored in unit_amenities and shown in Arabic.
- Transactions go through services/transaction.js withTransaction (retries a deadlock victim).

# Date rules (config/ejarRules.js, services/contractEngine.js)
- The Ejar rules exist once, in config/ejarRules.js (frozen). VERIFY every one against the official Ejar/REGA source before launch:
  - NON_RENEWAL_NOTICE_DAYS = 60: notice not to renew is due at least 60 days before end_date.
  - RENT_CHANGE_NOTICE_DAYS = 90: a rent change must be requested at least 90 days before end_date.
  - AUTO_RENEW_DEFAULT = true: without timely notice the contract renews for a term equal to the previous one.
  - RIYADH_RENT_FREEZE = { city: 'riyadh', from: '2025-09-25', years: 5 }: no rent increase in Riyadh when the new rent would take effect (end_date + 1) from 2025-09-25 up to 2030-09-24; a reduction is always allowed.
  - STAGE_THRESHOLDS = { soonDays: 30, urgentDays: 7 }, counted in days left to the notice deadline.
- Stages (classifyContract): terminated > renewed > ended (today after end_date; the end day itself is still running) > deadline_passed (after the notice deadline) > urgent (0..7 days left; the deadline day is urgent) > soon (8..30) > calm (more than 30). A contract that has not started is classified the same way and flagged notStarted.
- "today" is always passed in as riyadhDate(now). Dates are strict 'YYYY-MM-DD' (years 1900-2200; impossible dates throw ContractDateError 'invalid_date'). Months add with clamping to the month end; a term of n months ends on addMonths(start, n) minus one day.
- Money in the engine is integer halalas; schedules put the rounding remainder on the last installment.
- Hijri (formatHijri) is display only, labelled "تقريبي", never used in math.
- Never do date math outside services/contractDates.js and services/contractEngine.js, and never write a rule number anywhere but config/ejarRules.js.

# Contracts (routes/contracts.js, services/contracts.js, services/contractStatus.js)
- Routes (all 'contracts' unless noted): GET /office/contracts (filters stage incl. 'action', landlord, ends=30|60|90|180, q; sort deadline|end|created; 20 per page), GET /office/contracts/new, POST /office/contracts/preview (JSON, real engine, no database, 60 per minute per user), POST /office/contracts, GET /office/contracts/:id, GET+POST /office/contracts/:id/edit, POST /office/contracts/:id/payments/:paymentId ('payments.write'), GET+POST /office/contracts/:id/terminate ('contracts.terminate': owner and manager), GET+POST /office/contracts/:id/renew, POST /office/contracts/:id/delete ('contracts.delete'), POST /office/contracts/:id/invite (max 20 per office per hour), POST /office/contracts/:id/invite/revoke.
- Capabilities added for this: 'contracts.terminate' (owner, manager) and 'payments.write' for office_staff.
- The save logic (services/contracts.js) does not care where the numbers came from (hand entry now, AI later): it re-validates with the engine, never trusts the preview. Sanity errors block; warnings need the "راجعت التنبيهات" tick.
- Create = ONE transaction: contract plan limit (planLimits.contractUsage first; counts calm/soon/urgent/deadline_passed), unit row lock, unit must be vacant and of the same landlord, no overlap with another non-terminated contract on the unit (back to back is fine), contract with engine deadlines and stage, schedule rows, unit status, tenant invite, contract_events and audit row. Events and audit never hold the rent, the tenant label, the termination reason or notes.
- Unit becomes rented when the contract has started or starts within engine APP.rentedLeadDays (30). Otherwise the unit stays vacant with a 'unit_rent_pending' event, and recomputeStatuses flips it later.
- Immutable after save: dates, rent, frequency, unit and landlord. Only tenant_label, contract_number, deposit, commission and auto_renew are editable. To change the rest: terminate and create a new contract.
- Renewal creates a NEW contract for engine nextTerm() (renewed_from_id), marks the old one 'renewed' (renewed_at, renewed_to_id), keeps the unit rented, creates no new tenant invite, and refuses a rent increase while rentChangePolicy() says the Riyadh freeze applies. Terminated or renewed contracts cannot be renewed. Deleting a renewal restores the contract it renewed.
- Terminate: status 'terminated', terminated_at, reason; revokes tenant invites; waives future 'due' payments ("تم الإنهاء"); frees the unit unless another running contract occupies it.
- Delete: only without paid payments (checked in the DELETE) and never for ended or renewed contracts.
- Payments: due / paid / late / waived. Paid needs a date not in the future; receipt numbers are Latin letters and digits only (no names). A 'due' payment past its date shows as late (engine paymentDisplayStatus) and is stored as late by the recompute.
- services/contractStatus.js: planStatusChanges (pure) and recomputeStatuses({ pool, today, officeId? }) update stale stages in batches of 500, repair stored deadline copies from the engine, free units of ended contracts, rent units of started contracts and mark overdue payments late. Idempotent, retried on deadlock. No cron yet: the office home and contracts list call maybeRecompute, at most once an hour per office (office_settings 'contracts.status_recomputed_at'); a failure there is logged and the page still loads.
- Screens compute deadlines from end_date with the engine; the stored notice_deadline / rent_change_deadline copies are only for sorting and filtering.
- Hijri dates on contract screens are labelled "تقريبي".

# AI contract reading (services/aiContractReader.js, services/aiUsage.js)
- Routes: GET and POST /office/contracts/new/ai ('contracts.ai': owner, manager, staff). Success renders the SAME new-contract form, prefilled and marked, with the yellow "تمت القراءة بالذكاء الاصطناعي" banner; nothing is saved until the normal form submit (then contracts.source = 'ai').
- Env: CLAUDE_API_KEY (empty = feature off with an Arabic message, manual entry unaffected), CLAUDE_MODEL (default claude-sonnet-4-5). Built-in https to https://api.anthropic.com/v1/messages, anthropic-version 2023-06-01, 30 s timeout. No SDK dependency.
- Files: PDF, JPG, PNG, WebP up to 8 MB, type from magic bytes; images resized with sharp to at most 2000px. express-fileupload with useTempFiles false: the file lives in memory only and is never written to disk, the database, logs or error messages.
- The model returns only start_date, end_date, annual_rent, payment_frequency, city, property_type, ejar_contract_number. The server whitelists those keys, drops any value shaped like a national ID (10 digits starting 1 or 2) or an IBAN (SA + 22 digits), validates every value with the engine, and computes deadlines and stage itself. The raw reply is never logged; errors carry only a code.
- Limits: plans.max_ai_reads_monthly (NULL = unlimited) counted in ai_reads_usage per office and Riyadh month. A read reserves a slot first (office row locked, so parallel reads cannot pass the limit) and releases it if the read fails, so only successful reads count; over the limit there is no API call. Plus 5 requests per office per minute (in memory).

# Fixed table names
users, otp_codes, user_sessions, user_devices, notification_prefs, offices, office_members, office_branches, office_settings, office_secrets, landlords, buildings, units, unit_photos, unit_amenities, contracts, contract_members, contract_payments, contract_events, contract_notices, contract_renewals, contract_documents, extraction_jobs, ai_reads_usage, invites, maintenance_requests, maintenance_messages, maintenance_photos, vendors, listings, listing_inquiries, listing_views, plans, subscriptions, subscription_invoices, platform_payments, promo_codes, promo_usages, reminders, notifications, notification_log, message_templates, conversations, messages, tickets, ticket_messages, contact_messages, waitlist, audit_logs, staff_activity, office_tasks, internal_notes, blog_posts, testimonials, faqs, settings, page_views, cron_runs, backups, feature_flags
