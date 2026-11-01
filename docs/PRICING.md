# Pricing (approved, Prompt 21)

All prices in SAR, **excluding 15% VAT**, per office. Source of truth in code:
`services/officialPricing.js` (`OFFICIAL`). The plans table holds the live
values; an admin can change them in `/admin/plans`.

| | Trial | Basic «الأساسية» | Pro «الاحترافية» | Enterprise «المؤسسات» |
|---|---|---|---|---|
| Monthly | 0 (14 days, no card) | 149 | 349 | 799 |
| Yearly (10 months) | - | 1,490 | 3,490 | 7,990 |
| Units | 150 (= Pro) | 30 | 150 | 600 |
| Team members (owner included) | 6 (= Pro) | 2 | 6 | 20 |
| AI contract reads / month | 100 (= Pro) | 20 | 100 | 400 |
| Published public listings | 50 (= Pro) | 10 | 50 | 200 |
| Reminder channels | all | site + email + Telegram | + WhatsApp | all |
| Public office link | yes | yes | yes | yes |
| Custom domain | no | not available | optional add-on, 49 SAR/month | 1 included |
| Audit log | full | basic | full (+ reports) | full |
| Support | email | email | email + WhatsApp | priority |

Above 600 units: «باقة مخصصة», no price, contact form only (`/contact`). It is a
card on the pricing page, not a plan row.

## What is enforced

| Limit | Enforced on the server? | Where |
|---|---|---|
| Units | **yes** | `planLimits.unitUsage` in the creating transaction (office row locked) |
| Team members | **yes** | `planLimits.memberUsage` at invite, redeem and reactivate |
| Published public listings | **yes** | `planLimits.listingUsage` (counts listings not `rented`) |
| AI contract reads / month | **yes** | `aiUsage.reserve` (slot reserved before any API call, released on failure) |
| WhatsApp / Telegram channels | **yes** | plan feature switches (`features.officeAllows`): settings pages and delivery skip a channel the plan lacks |
| Email and site channels | always on | not a plan feature |
| Custom domain (none / add-on / included) | **stored only** | `plans.custom_domain` and settings `addons.custom_domain`; no domain or billing logic exists yet, the pricing page says «قريباً» |
| Audit log basic / full | **stored only** | `plans.audit_level`; the office audit page is the same for every plan |
| Support level | **stored only** | `plans.support_level`; shown on the pricing page |

Kept from before (not in the approved table): `max_photos` (maintenance
photos; Basic 200, Pro 1000, Enterprise unlimited, Trial = Pro) is still
enforced; `max_contracts` is set to unlimited because one running contract per
unit means the unit limit already bounds it.

## Migration

`applyOfficialPricing` runs at every start (`ensureSchema`) and in
`node database/seed.js`:

- updates the rows `trial`, `basic`, `pro`, `enterprise` by code; a value
  changes only while it still equals the old placeholder (99 / 249 / 599 and
  the old limits), so an admin's edit is never overwritten;
- sets `custom_domain`, `audit_level`, `support_level`, `is_active = 1` and
  `is_public = 1` (paid plans) once per plan (settings
  `plans.official_pricing_v1.<code>`), so a later admin change sticks;
- inserts the add-on record `addons.custom_domain` once
  (`{ name_ar, price_monthly: "49.00", currency: "SAR", plans: ["pro"] }`);
- never changes `offices.plan_id`.

If `/pricing` shows no plans, the rows were never created: run
`node database/seed.js` once (it creates missing plans with these values).

`/admin/launch` check «الباقات والأسعار» fails while an active plan other
than the trial has a monthly or yearly price of 0, an active plan lacks one of
the four limits above, or no paid plan is published.
