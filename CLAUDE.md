# Project: Aqdi (working name: عقدي)
Arabic PWA for Saudi Arabia with three roles on one platform:
1. Office (real-estate office owner). Pays the subscription. Registers landlords and their units, uploads rental contracts, sees every contract with its deadlines, and later publishes units with photos.
2. Landlord (المؤجر). Belongs to an office. Joins with an invite code from the office. Sees only his own units and contracts.
3. Tenant (المستأجر). Free. Joins with an invite code created when the office saves his contract. Sees only his own contract, dates and reminders. Later: browses published units and contacts the office.
Contracts are made on the government platform Ejar. This app never connects to Ejar and never replaces it. The office downloads the contract PDF from Ejar and uploads it here; AI reads it and the app tracks the dates and sends reminders.

# Stack
Next.js 16 (App Router, src/ folder) + TypeScript + Tailwind + Supabase (phone OTP auth, Postgres with RLS, Storage later) + Claude API for contract reading + Vercel hosting. Follow AGENTS.md for Next.js 16 specifics.

# Rules you must follow
1. The UI is Arabic, RTL, mobile-first, with large text and obvious buttons, for non-technical users. All user-facing text is in Arabic; code, comments and commit messages are in English.
2. Simplicity beats features. Never add a feature I did not ask for.
3. No Ejar logo, colors, or anything that suggests the app is official or government. Where needed, show: 'تطبيق خاص غير تابع لمنصة إيجار، والتواريخ للتذكير فقط'.
4. Privacy: never store national ID or iqama numbers, party names, IBAN, utility meter numbers or full addresses from contracts. Extract only the fields we need and never persist the original file unless a task says so. Never log contract contents.
5. Secrets live only in environment variables, never in code. .env.local is in .gitignore. Never print a secret.
6. Dates: store Gregorian (YYYY-MM-DD) for all calculations; Hijri is display-only text. Timezone is Asia/Riyadh.
7. Date calculation functions are pure, isolated, and covered by unit tests.
8. Security: every table has Row Level Security. A user only reads rows that belong to his role and his office or contract. The service role key is used only in server code, never in the browser.
9. After every task: run lint, build and tests, fix failures, commit with a clear message, push to main, then tell me in simple Arabic what I should check in the browser.
10. Ask me before adding a paid service or a dependency that is not obviously needed.

# Fixed table names
profiles, offices, landlords, units, contracts, contract_members, reminders, push_subscriptions, invites, waitlist
