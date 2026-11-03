# Custom domains for offices

An office can ask for its own domain (for example `myoffice.sa`) from
**Office > Settings > نطاق مكتبك**. The free link `<APP_URL host>/<slug>` keeps
working in every case.

The app does **not** buy domains, change DNS or issue SSL certificates: those
steps are manual (below). Since Prompt 24 it **does** answer on an active
domain: a request whose Host is the office's live custom domain shows that
office's public page (see "What a custom domain serves").

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

## What a custom domain serves (host-based routing)

`middleware/customHost.js` runs first in `app.js` and reads the raw `Host`
header (never `X-Forwarded-Host`):

- **Main hosts** behave as before: the host of `APP_URL`, `localhost`,
  `127.0.0.1`, `::1` and anything in `ALLOWED_HOSTS` (comma separated).
  Without `APP_URL` every host is a main host, so custom domains are off.
- **Any other host** is looked up once (cached in memory: 60 s when found,
  30 s when not, 1000 hosts at most; new lookups are limited to 60 per IP per
  minute). It is served only when all of these hold:
  - `offices.custom_domain` equals the host.
  - The office's **latest** domain request is `active`.
  - The public page is visible: switched on, and the office is active,
    past_due, or in a trial that has not expired.

  Otherwise the answer is a plain 404 that reveals nothing.
- `www.<domain>` answers 301 to `https://<domain>` with the same path.

On a served domain:

| Path | Answer |
|---|---|
| `GET /` | the office's public page with its listings and pages |
| `GET /listings/:id`, `POST /listings/:id/inquiry`, `GET /listings/photos/:id/:variant` | only that office's public listings; any other id is 404 |
| `GET /robots.txt`, `GET /sitemap.xml` | that office only, absolute URLs on its domain |
| static files, `/health`, `/healthz` | as on the main host |
| anything else (login, panels, admin, blog, pricing, other offices) | 302 to the same path on `APP_URL` |

More details:

- No session or login cookie is ever read, cleared or set on a custom domain.
  The inquiry form is protected by the usual same-origin check: its `Origin`
  must be the custom domain itself.
- Canonical and `og:url` use the custom domain. `/<slug>` on the main host
  keeps working and points `rel=canonical` at the live custom domain.
- Every response on a custom domain carries `X-Aqdi-Office-Host: <slug>`.
- The cache is cleared when you save a domain request in `/admin/domains`,
  and when an office changes its link or public page. Any other change (a
  subscription ending, for example) takes effect within 60 seconds.

## Manual procedure for one domain

1. **The office gets the domain.**
   - Own domain: the office already has it.
   - Reserve: check availability, enter the cost, buy it **in the office's
     name**, then move the request to `pending_setup`.
2. **You add the domain in cPanel**, pointing at the same Node app:
   1. In **Domains**, create the domain (an alias, also called a parked
      domain, or an addon domain).
   2. Make sure its document root serves the same Passenger application as
      `aqdi.phillote.com`. On some cPanel versions you also add the domain in
      **Setup Node.js App** (Application URL), or use an alias of the main
      domain.
   3. Do **not** put `.htaccess` redirects on it. The app needs to receive
      the original `Host`.
3. **The office adds the DNS records at its registrar.**
   - Either `A @ -> <server IP>` and `CNAME www -> <main domain>` (the values
     come from `APP_DOMAIN_IP` and `APP_DOMAIN_TARGET`, which the office sees
     in its settings with the records method),
   - or nameservers you host (nameservers method; fill Nameserver 1 and 2 on
     the request).

   Move the request to `awaiting_dns` or `awaiting_nameservers` so the office
   sees what to do.
4. **Wait for propagation and SSL.** Use **فحص الانتشار** for the NS
   records. Once DNS points at the server, run **SSL/TLS Status > Run
   AutoSSL** in cPanel, or wait for its next run. AutoSSL only succeeds after
   DNS points at the server.
5. **Mark the request active** in `/admin/domains` (status "تفعيل", with a
   reason). The app starts answering on the domain at once; the cache is
   cleared.
6. **Press «فحص الدومين»** on the request. It looks up the A and CNAME
   records and sends an HTTPS HEAD to `https://<domain>/` (5 s). It shows:
   - the HTTP status, or the certificate or connection error text;
   - whether the answer is this office on this app (the
     `X-Aqdi-Office-Host` header equals the office's slug).

**What could not be verified from the development environment** (check on the
real server):

- **Alias/addon setup:** whether your cPanel version lets an alias or addon
  domain reach the same Passenger Node app without extra settings (step 2).
- **The `Host` header:** that Passenger and Apache pass the original `Host`
  to Node for an alias domain, and do not rewrite it to the main domain.
- **AutoSSL:** that AutoSSL issues certificates for alias or addon domains on
  this hosting plan, and how long that takes (step 4).
- **Outbound access:** that the server is allowed to make outbound DNS
  queries and HTTPS requests. «فحص الدومين» and «فحص الانتشار» need both.

## Planned later: Cloudflare API on a VPS (not implemented)

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
- **SSL:** a proxied DNS record to the VPS, Cloudflare edge certificates and
  an origin certificate on the VPS. Host-based routing already exists
  (Prompt 24).
- **Secrets:** the Cloudflare API token lives only in the environment, scoped
  to zone creation and DNS edits. It is never logged.
- The records method keeps working as a fallback for offices that cannot
  change nameservers.
