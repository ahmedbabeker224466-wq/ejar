# Custom domains for offices

An office can ask for its own domain (for example `myoffice.sa`) from
**Office > Settings > نطاق مكتبك**. The free link `<APP_URL host>/<slug>` keeps
working in every case.

Today everything after the request is done **by hand** by the platform admin.
The app tracks requests and statuses, notifies the office, and stores the
domain on the office when it is activated. It does **not** buy domains,
change DNS, issue SSL certificates or route a domain to the app.

## What the office sees

- **Plan gating** comes from the plan's `custom_domain` mode in `/admin/plans`
  data, set by the pricing migration:
  - `none` (Basic): the section is locked, with an upgrade button.
  - `addon` (Pro): requests are allowed. The add-on price (settings
    `addons.custom_domain`, 49 SAR/month) is shown and saved on the request.
    Nothing is charged automatically.
  - `included` (Enterprise): requests are allowed (one active domain per
    office).
- **Choices:**
  - **لدي دومين** (own): the domain plus a connection method, either
    **Nameservers** (default) or **DNS records**.
  - **احجز لي دوميناً** (reserve): the desired name plus up to 2 alternatives.
    Price: the real domain cost plus a 40 SAR service fee, registered in the
    office's name. Availability is checked after the request.
  - **ليس الآن**: nothing is requested.
- **Who can do what:** only the owner can create or cancel a request. Managers
  and staff see the status.
- **One open request per office:** open means any status except `active`,
  `rejected` and `cancelled`. An office that already has an active domain
  cannot request another; it contacts support.
- **What the office sees while waiting:**
  - **Nameservers:** once you fill `assigned_ns_1` and `assigned_ns_2`, the
    office sees both in a copy box with
    «غيّر Nameservers الدومين عند مزودك إلى القيمتين التاليتين». Until then it
    sees «سيرسل لك الدعم القيم قريباً».
  - **Records:** the office sees `CNAME www -> APP_DOMAIN_TARGET` and
    `A @ -> APP_DOMAIN_IP`, both from the environment (empty = «سيرسل لك الدعم
    القيم قريباً»).

## Statuses

| Status | Meaning |
|---|---|
| `pending_purchase` | reserve: you have to check availability and buy the domain |
| `pending_setup` | own (or bought): you have to prepare the DNS side |
| `awaiting_nameservers` | the office must switch its nameservers to the assigned values |
| `awaiting_dns` | the office must add the CNAME / A records |
| `active` | done: the domain is stored on the office (`offices.custom_domain`, unique) |
| `rejected` | refused (tell the office why in your own words) |
| `cancelled` | cancelled by the office |

`active`, `rejected` and `cancelled` are final. Each status change notifies the
office owner (on the site, and by email when SMTP and the owner's email are
set), and is audited with your written reason.

## Manual procedure for the platform admin

1. Open **/admin/domains** (filter "المفتوحة فقط").
2. **Reserve requests** (`pending_purchase`):
   1. Check availability of the name and its alternatives at a registrar.
   2. Enter the real cost in "تكلفة الدومين" so the office sees it. Agree
      payment with the office outside the app (the cost plus the 40 SAR fee).
   3. Buy the domain **in the office's name**.
   4. Move the request to `pending_setup`.
3. **DNS setup:**
   - **Nameservers method:** create the DNS zone where you host DNS (today
     cPanel > Zone Editor, or a DNS provider). Copy the zone's two nameservers
     into Nameserver 1 and 2, and an id of the zone into `dns_zone_ref`.
     Move to `awaiting_nameservers`. The office now sees the two values.
   - **Records method:** set `APP_DOMAIN_TARGET` and `APP_DOMAIN_IP` in the
     environment once (restart the app), then move to `awaiting_dns`.
4. Press **فحص الانتشار** on the request. It runs a normal NS lookup (Node's
   built-in `dns` module) and shows the current NS records, and whether they
   match the assigned ones. It changes nothing. Propagation can take from
   minutes to 48 hours.
5. On the server, make the domain reach the app: in cPanel add the domain
   (Domains > Create a New Domain, or an Addon Domain) pointing at the app,
   map it in Setup Node.js App if needed, and issue SSL (SSL/TLS Status >
   Run AutoSSL). Open `https://<domain>/health` to check.
6. Move the request to **active** (the dropdown says "تفعيل"). This stores the
   domain on the office. **Routing stays manual**: the app does not yet serve
   the office page on that domain. Whatever step 5 set up is what visitors
   get.
7. If anything cannot be done, move the request to `rejected`, write the
   reason, and contact the office.

The launch check «طلبات الدومين» on `/admin/launch` warns while an open
request has not changed for more than 3 days.

## Planned: Prompt 24, Cloudflare API on a VPS (not implemented)

When the app moves to a VPS, a later change can automate steps 3 to 6 without
changing the office screens. The office UI already reads only the status,
`assigned_ns_1/2` and the records config.

- **Create the zone:** on `pending_setup`, create a Cloudflare zone for the
  domain through the Cloudflare API. Store the zone id in `dns_zone_ref`, and
  the two nameservers Cloudflare returns in `assigned_ns_1/2`. Move to
  `awaiting_nameservers` and notify the office (the existing notification).
- **Track propagation:** a cron job polls the zone status (and the same NS
  lookup) and moves the request to `active` when Cloudflare reports the zone
  as active.
- **SSL and routing:** a proxied DNS record to the VPS, Cloudflare edge
  certificates, an origin certificate on the VPS, and host-based routing in
  the app (`offices.custom_domain` -> the office page).
- **Secrets:** the Cloudflare API token lives only in the environment, scoped
  to zone creation and DNS edits. It is never logged.
- The records method keeps working as a fallback for offices that cannot
  change nameservers.
