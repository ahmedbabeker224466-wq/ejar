# Project
A simple Arabic-first web app (PWA) for users in Saudi Arabia. A user (tenant or landlord) uploads a rental contract downloaded from the Ejar platform. The app reads the contract with AI, calculates the key dates, and reminds the user. No integration with Ejar, no contract registration, no renewals, no rent collection, no maintenance. It is a reader and a reminder only.

# Stack
Next.js (App Router) + TypeScript + Tailwind + Supabase (auth, Postgres, storage) + Claude API for contract reading + Vercel for hosting.

# Rules you must follow
1. The UI is Arabic and right-to-left (dir="rtl", lang="ar"), mobile-first, with large text and obvious buttons for non-technical users. All user-facing text is in Arabic; code, comments and commit messages are in English.
2. Simplicity beats features. Never add a feature I did not ask for.
3. No Ejar logo, colors, or anything that suggests the app is official or government. Where needed, show: "تطبيق خاص غير تابع لمنصة إيجار، والتواريخ للتذكير فقط".
4. Privacy: never store national ID / iqama numbers, party names, or full addresses. Extract only the fields we need and never persist the original file.
5. Secrets (API keys) live only in environment variables, never in code. .env.local is in .gitignore.
6. Dates: contracts may show Hijri and Gregorian dates. Store Gregorian dates (YYYY-MM-DD) for all calculations; store Hijri as display-only text when present. Timezone is Asia/Riyadh.
7. Date calculation functions are pure, isolated, and covered by unit tests.
8. After each task: run lint, tests and build, then give me a 2-line summary. Do not commit unless I ask.

# Fixed table names (do not rename without asking)
profiles · contracts · reminders · push_subscriptions · waitlist
