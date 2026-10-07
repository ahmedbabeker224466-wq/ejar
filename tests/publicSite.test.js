'use strict';

// Pure checks for the public site: contact-detail detection, the Markdown
// subset, SEO helpers, the analytics snippet allowlist, neighborhoods and the
// listing form validation. No database.

const test = require('node:test');
const assert = require('node:assert/strict');

const { findContact, cleanText, hasLink } = require('../services/publicText');
const markdown = require('../services/markdown');
const seo = require('../services/seo');
const { sanitizeSnippet, extendCsp } = require('../services/analytics');
const { neighborhoodsFor, isNeighborhood, OTHER } = require('../config/neighborhoods');
const listings = require('../services/listings');
const inquiries = require('../services/inquiries');
const rules = require('../config/listings');

test('contact details are found in any digit script, with separators, links, emails and IBANs', () => {
  for (const [text, kind] of [
    ['اتصل 0555123456', 'phone'], ['٠٥٥٥١٢٣٤٥٦', 'phone'], ['0555 123 456', 'phone'], ['055-512-3456', 'phone'], ['+966 55 512 3456', 'phone'], ['(055) 512.3456', 'phone'],
    ['https://example.com/x', 'url'], ['زوروا www.shop.sa', 'url'], ['wa.me/966555', 'url'], ['example.com', 'url'], ['bit.ly/abc', 'url'],
    ['a.b@example.org', 'email'], ['راسلنا @aqdi_sa', 'email'],
    ['SA03 8000 0000 6080 1016 7519', 'iban'], ['sa0380000000608010167519', 'iban'],
  ]) assert.equal(findContact(text), kind, text);
  for (const text of ['شقة 150 متر في الدور الثاني', 'الإيجار 36000 ريال', 'غرفتان وصالة ومطبخ', 'بناء 2024 حديث', '']) assert.equal(findContact(text), null, text);
  assert.equal(hasLink('زوروا موقعنا https://x.co'), true);
  assert.equal(hasLink('اتصل بي 0555123456'), false, 'a visitor may leave a number in a message');
  assert.equal(cleanText('  مرحبا\r\n\r\n\r\n\r\nبكم\u0000  ', 100, { multiline: true }), 'مرحبا\n\nبكم');
  assert.equal(cleanText('a   b\n c', 100), 'a b c');
});

test('markdown: only the safe subset survives, HTML is escaped, bad links stay text', () => {
  const html = markdown.render('# عنوان\n\n## فرعي\n\nنص **غامق** و *مائل* <script>alert(1)</script> <img src=x onerror=alert(2)>\n\n- بند\n- بند ٢\n\n1. أول\n2. ثاني\n\n> اقتباس\n\n---\n\n[موقع](https://example.com/a?b=1&c=2) [نسبي](/blog) [سيء](javascript:alert(1)) [بيانات](data:text/html,x)');
  assert.match(html, /<h2>عنوان<\/h2>/, 'a single # is an h2: the page title is the only h1');
  assert.doesNotMatch(html, /<h1/);
  assert.match(html, /<h2>فرعي<\/h2>/);
  assert.match(html, /<strong>غامق<\/strong>/);
  assert.match(html, /<em>مائل<\/em>/);
  assert.match(html, /<ul><li>بند<\/li><li>بند ٢<\/li><\/ul>/);
  assert.match(html, /<ol><li>أول<\/li><li>ثاني<\/li><\/ol>/);
  assert.match(html, /<blockquote><p>اقتباس<\/p><\/blockquote>/);
  assert.match(html, /<hr>/);
  assert.match(html, /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2" rel="nofollow noopener noreferrer">موقع<\/a>/);
  assert.match(html, /<a href="\/blog">نسبي<\/a>/);
  assert.doesNotMatch(html, /<script|<img|onerror=alert\(2\)>|href="javascript|href="data/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /\[سيء\]\(javascript:alert\(1\)\)/, 'a javascript: link is only text');
  assert.equal(markdown.plain('## عنوان **غامق** [رابط](https://x.co)'), 'عنوان غامق رابط');
  // Unclosed constructs and odd input never throw or produce raw tags.
  for (const input of ['**', '[', '[a](', '<', '`x', '> ', '- ', '']) assert.doesNotThrow(() => markdown.render(input));
  assert.equal(markdown.render('"><svg onload=1>').includes('<svg'), false);
});

test('seo helpers: JSON-LD cannot close its tag, sitemap and RSS are escaped, robots blocks the private areas', () => {
  const evil = '</script><script>alert(1)</script>';
  const json = seo.safeJson({ name: evil, other: 'a&b' });
  assert.ok(!json.includes('<'));
  assert.ok(!json.includes('</script'));
  assert.deepEqual(JSON.parse(json), { name: evil, other: 'a&b' }, 'it still parses to the same value');
  const xml = seo.sitemapXml('https://aqdi.example', [{ path: '/a&b', lastmod: new Date('2026-10-01T10:00:00Z'), changefreq: 'weekly', priority: '0.5' }]);
  assert.match(xml, /<loc>https:\/\/aqdi\.example\/a&amp;b<\/loc>/);
  assert.match(xml, /<lastmod>2026-10-01<\/lastmod>/);
  const rss = seo.rssXml({ base: 'https://aqdi.example', title: 'عنوان & <b>', description: 'd', items: [{ title: '<x>&"', link: 'https://aqdi.example/blog/x', description: 'د\u0001ص', date: new Date('2026-10-01T00:00:00Z'), guid: 'g' }] });
  assert.ok(!rss.includes('<b>') && !rss.includes('<x>'));
  assert.ok(!rss.includes('\u0001'));
  assert.match(rss, /Thu, 01 Oct 2026 00:00:00 GMT/);
  const robots = seo.robotsTxt('https://aqdi.example');
  for (const dir of ['/office', '/admin', '/landlord', '/tenant', '/api', '/maintenance']) assert.match(robots, new RegExp(`^Disallow: ${dir}$`, 'm'));
  assert.match(robots, /Sitemap: https:\/\/aqdi\.example\/sitemap\.xml/);
  const req = (host) => ({ protocol: 'https', get: () => host });
  const keep = process.env.APP_URL;
  try {
    process.env.APP_URL = 'https://aqdi.example/';
    assert.equal(seo.baseUrl(req('evil.example')), 'https://aqdi.example', 'the configured URL wins over the Host header');
    process.env.APP_URL = '';
    assert.equal(seo.baseUrl(req('host.example')), 'https://host.example');
    process.env.APP_URL = 'javascript:alert(1)';
    assert.equal(seo.baseUrl(req('host.example')), 'https://host.example');
  } finally {
    if (keep === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = keep;
  }
});

test('listing JSON-LD holds only what the public page shows', () => {
  const listing = { id: 5, title: 'شقة للإيجار في حي الملقا، الرياض', unitType: 'apartment', city: 'الرياض', neighborhood: 'الملقا', rooms: 3, area: 150, price: 3600000, officeName: 'مكتب الأمل' };
  const data = seo.listingJsonLd({ listing, base: 'https://aqdi.example', imageUrl: 'https://aqdi.example/listings/photos/1/full' });
  assert.equal(data['@type'], 'Offer');
  assert.equal(data.price, '36000.00');
  assert.equal(data.priceCurrency, 'SAR');
  assert.equal(data.itemOffered['@type'], 'Apartment');
  assert.equal(data.itemOffered.numberOfRooms, 3);
  assert.deepEqual(Object.keys(data.itemOffered.address).sort(), ['@type', 'addressCountry', 'addressLocality', 'addressRegion']);
  assert.equal(data.seller.name, 'مكتب الأمل');
});

test('analytics snippet: one script tag from a known provider, rebuilt without anything else', () => {
  assert.deepEqual(sanitizeSnippet(''), { ok: true, snippet: '', origins: [] });
  assert.deepEqual(sanitizeSnippet('   '), { ok: true, snippet: '', origins: [] });
  const ok = sanitizeSnippet('<script defer data-domain="aqdi.sa" src="https://plausible.io/js/script.js"></script>');
  assert.equal(ok.ok, true);
  assert.equal(ok.snippet, '<script src="https://plausible.io/js/script.js" defer data-domain="aqdi.sa"></script>');
  assert.deepEqual(ok.origins, ['https://plausible.io']);
  assert.equal(sanitizeSnippet('<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC123"></script>').ok, true);
  for (const bad of [
    '<script>alert(1)</script>', '<script src="https://evil.example/x.js"></script>', '<script src="http://plausible.io/x.js"></script>',
    '<script src="https://plausible.io/x.js" onload="x()"></script>', '<script src="https://plausible.io:8443/x.js"></script>',
    '<script src="https://user:pw@plausible.io/x.js"></script>', '<script src="https://plausible.io/x.js"></script><script src="https://plausible.io/y.js"></script>',
    '<img src=x onerror=alert(1)>', '<script src="https://plausible.io/x.js">alert(1)</script>', '<script src="javascript:alert(1)"></script>',
    '<script src="https://plausible.io/x.js" data-x="a b\' onerror=\'1"></script>', '<script src="https://plausible.io/x.js" src="https://plausible.io/y.js"></script>',
    '<script src="https://plausible.io.evil.example/x.js"></script>', `<script src="https://plausible.io/${'a'.repeat(1100)}"></script>`,
  ]) assert.equal(sanitizeSnippet(bad).ok, false, bad.slice(0, 80));
  const csp = "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'";
  const extended = extendCsp(csp, ['https://plausible.io']);
  assert.match(extended, /script-src 'self' https:\/\/plausible\.io/);
  assert.match(extended, /connect-src 'self' https:\/\/plausible\.io/);
  assert.match(extended, /img-src 'self' data: https:\/\/plausible\.io/);
  assert.match(extended, /style-src 'self'$/, 'styles are untouched');
  assert.equal(extendCsp(csp, []), csp);
});

test('neighborhoods are a fixed list per city, always with "other"', () => {
  assert.ok(neighborhoodsFor('الرياض').includes('الملقا'));
  assert.equal(neighborhoodsFor('الرياض').at(-1), OTHER);
  assert.deepEqual(neighborhoodsFor('تبوك'), [OTHER], 'a city without a list offers only "other"');
  assert.equal(isNeighborhood('الرياض', 'الملقا'), true);
  assert.equal(isNeighborhood('جدة', 'الملقا'), false);
  assert.equal(isNeighborhood('الرياض', 'شارع الملك فهد 12'), false, 'no free text');
  assert.equal(isNeighborhood('الرياض', ''), false);
});

test('listing form: title never holds a unit label; filters keep only valid values', () => {
  assert.equal(listings.titleFor({ unit_type: 'villa', city: 'جدة', neighborhood: 'الروضة' }), 'فيلا للإيجار في حي الروضة، جدة');
  assert.equal(listings.titleFor({ unit_type: 'apartment', city: 'الرياض', neighborhood: 'أخرى' }), 'شقة للإيجار في الرياض');
  const ok = listings.validateListing({ unit_type: 'apartment', city: 'الرياض', neighborhood: 'الملقا', price: '36,000', rooms: '٣', bathrooms: '2', area_sqm: '150.5', description: 'شقة هادئة جداً', features: ['ac', 'furnished'] });
  assert.deepEqual(ok.errors, {});
  assert.equal(ok.values.price, 3600000);
  assert.equal(ok.values.rooms, 3);
  assert.equal(ok.values.area_sqm, '150.50');
  assert.deepEqual(ok.values.features, ['ac', 'furnished']);
  const filters = listings.parseFilters({ city: 'الرياض', neighborhood: 'الملقا', type: 'villa', rooms: '4+', min_price: '1000', max_price: 'abc', sort: 'price_desc', page: '3' });
  assert.deepEqual([filters.city, filters.neighborhood, filters.type, filters.rooms.min, filters.rooms.exact, filters.minPrice, filters.maxPrice, filters.sort, filters.page], ['الرياض', 'الملقا', 'villa', 4, false, 100000, undefined, 'price_desc', 3]);
  const junk = listings.parseFilters({ city: "' OR 1=1", neighborhood: 'x'.repeat(500), type: 'castle', rooms: '99', sort: 'DROP', page: '-4' });
  assert.deepEqual([junk.city, junk.neighborhood, junk.type, junk.rooms, junk.sort, junk.page], [undefined, undefined, undefined, undefined, 'newest', 1]);
  assert.deepEqual(listings.missingForPublish({ price: '0.00', description: '', neighborhood: '' }, 0), ['الإيجار السنوي', 'وصف قصير (10 أحرف على الأقل)', 'الحي', 'صورة واحدة على الأقل']);
  assert.deepEqual(listings.missingForPublish({ price: '100.00', description: 'وصف قصير جداً', neighborhood: 'الملقا' }, 2), []);
});

test('visitor forms: phone or email, honeypot, links refused, normalized numbers', () => {
  assert.equal(inquiries.cleanPhone('0555 000 111'), '966555000111');
  assert.equal(inquiries.cleanPhone('+44 7700 900123'), '447700900123');
  assert.equal(inquiries.cleanPhone('abc'), null);
  assert.equal(inquiries.cleanPhone(''), '');
  assert.equal(inquiries.cleanEmail('A@B.CO'), 'a@b.co');
  assert.equal(inquiries.cleanEmail('a@b'), null);
  const v = (body) => inquiries.validateInquiry(body);
  assert.deepEqual(Object.keys(v({ message: 'x' }).errors), ['contact']);
  assert.deepEqual(v({ phone: '0555000111' }).errors, {});
  assert.deepEqual(v({ email: 'a@b.co', message: 'مرحبا' }).errors, {});
  assert.equal(v({ phone: '0555000111', website: 'http://bot' }).bot, true);
  assert.equal(v({ phone: '0555000111', website: '' }).bot, false);
  assert.ok(v({ phone: '0555000111', message: 'see https://spam.example' }).errors.message);
  assert.ok(v({ phone: '0555000111', name: 'www.spam.com' }).errors.name);
  assert.ok(v({ phone: '0555000111', message: 'x'.repeat(rules.INQUIRY_MESSAGE_MAX + 1) }).errors.message);
  assert.equal(v({ phone: '0555000111', message: 'x'.repeat(rules.INQUIRY_MESSAGE_MAX) }).errors.message, undefined);
  assert.ok(inquiries.validateContact({ phone: '0555000111', message: '' }, { messageMax: 1000, messageRequired: true }).errors.message);
});

test('listing constants: 60 days, remind 7 days before, 90 days of inquiries, 8 photos, 12 per page', () => {
  assert.deepEqual([rules.LISTING_DAYS, rules.REMIND_DAYS, rules.INQUIRY_KEEP_DAYS, rules.MAX_PHOTOS, rules.PAGE_SIZE], [60, 7, 90, 8, 12]);
  assert.equal(Object.isFrozen(rules), true);
});
