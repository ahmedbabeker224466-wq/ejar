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

# Fixed table names
users, otp_codes, user_sessions, user_devices, notification_prefs, offices, office_members, office_branches, office_settings, office_secrets, landlords, buildings, units, unit_photos, unit_amenities, contracts, contract_members, contract_payments, contract_events, contract_notices, contract_renewals, contract_documents, extraction_jobs, maintenance_requests, maintenance_messages, maintenance_photos, vendors, listings, listing_inquiries, listing_views, plans, subscriptions, subscription_invoices, platform_payments, promo_codes, promo_usages, reminders, notifications, notification_log, message_templates, conversations, messages, tickets, ticket_messages, contact_messages, waitlist, audit_logs, staff_activity, office_tasks, internal_notes, blog_posts, testimonials, faqs, settings, page_views, cron_runs, backups, feature_flags
