'use strict';

// SEO helpers for the public pages: absolute URLs, JSON-LD (safe to print inside
// a script tag), sitemap.xml, robots.txt and RSS escaping. Pure functions.

const { riyadhDate } = require('./contractDates');

/** The public base URL: APP_URL when set, otherwise what the request says. No trailing slash. */
function baseUrl(req) {
  const configured = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (/^https?:\/\/[^\s/]+$/i.test(configured)) return configured;
  return `${req.protocol}://${req.get('host')}`;
}

const absolute = (base, path) => `${base}${path.startsWith('/') ? path : `/${path}`}`;

/** JSON for a <script type="application/ld+json"> block: nothing in it can close the tag. */
function safeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

const SCHEMA_TYPES = { apartment: 'Apartment', villa: 'House', shop: 'Accommodation', office: 'Accommodation', warehouse: 'Accommodation', land: 'Accommodation', other: 'Accommodation' };

/**
 * Minimal Offer + residence data for a listing. Only what the page already
 * shows: type, city, neighborhood, rooms, baths, area, annual rent, office name.
 */
function listingJsonLd({ listing, base, imageUrl }) {
  const place = { '@type': SCHEMA_TYPES[listing.unitType] || 'Accommodation', name: listing.title, address: { '@type': 'PostalAddress', addressLocality: listing.city, addressCountry: 'SA' } };
  if (listing.neighborhood) place.address.addressRegion = listing.neighborhood;
  if (listing.rooms !== null) place.numberOfRooms = listing.rooms;
  if (listing.area !== null) place.floorSize = { '@type': 'QuantitativeValue', value: listing.area, unitCode: 'MTK' };
  return {
    '@context': 'https://schema.org',
    '@type': 'Offer',
    url: absolute(base, `/listings/${listing.id}`),
    name: listing.title,
    price: (listing.price / 100).toFixed(2),
    priceCurrency: 'SAR',
    availability: 'https://schema.org/InStock',
    priceSpecification: { '@type': 'UnitPriceSpecification', price: (listing.price / 100).toFixed(2), priceCurrency: 'SAR', unitText: 'YEAR' },
    seller: { '@type': 'Organization', name: listing.officeName },
    itemOffered: place,
    ...(imageUrl ? { image: imageUrl } : {}),
  };
}

function xmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]))
    // XML 1.0 forbids most control characters.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

/** sitemap.xml for [{ path, lastmod? (Date), changefreq?, priority? }]. */
function sitemapXml(base, entries) {
  const urls = entries.map((e) => {
    const parts = [`<loc>${xmlEscape(absolute(base, e.path))}</loc>`];
    if (e.lastmod) parts.push(`<lastmod>${riyadhDate(new Date(e.lastmod))}</lastmod>`);
    if (e.changefreq) parts.push(`<changefreq>${e.changefreq}</changefreq>`);
    if (e.priority) parts.push(`<priority>${e.priority}</priority>`);
    return `  <url>${parts.join('')}</url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

// Private areas and the pages that need a login or hold private files.
const PRIVATE_PATHS = ['/office', '/admin', '/landlord', '/tenant', '/platform', '/api', '/login', '/register', '/join', '/logout', '/notifications', '/settings', '/maintenance', '/webhooks', '/cron', '/health'];

function robotsTxt(base) {
  return [
    'User-agent: *',
    ...PRIVATE_PATHS.map((p) => `Disallow: ${p}`),
    'Allow: /',
    '',
    `Sitemap: ${base}/sitemap.xml`,
    '',
  ].join('\n');
}

/** An RSS 2.0 feed for [{ title, link, description, date (Date), guid }]. */
function rssXml({ base, title, description, items }) {
  const rows = items.map((i) => `    <item>
      <title>${xmlEscape(i.title)}</title>
      <link>${xmlEscape(i.link)}</link>
      <guid isPermaLink="true">${xmlEscape(i.link)}</guid>
      <pubDate>${new Date(i.date).toUTCString()}</pubDate>
      <description>${xmlEscape(i.description)}</description>
    </item>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${xmlEscape(title)}</title>
    <link>${xmlEscape(base)}/blog</link>
    <description>${xmlEscape(description)}</description>
    <language>ar</language>
${rows.join('\n')}
  </channel>
</rss>
`;
}

module.exports = { baseUrl, absolute, safeJson, listingJsonLd, xmlEscape, sitemapXml, PRIVATE_PATHS, robotsTxt, rssXml };
