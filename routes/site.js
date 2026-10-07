'use strict';

// The marketing site, the blog, the contact form, sitemap.xml and robots.txt.
// Everything is public, server-rendered and cached for a minute. The seller
// and support details on the legal pages come from the platform settings
// (nothing about the company is hardcoded). No page claims any affiliation
// with, approval by or compliance with Ejar, REGA or ZATCA.

const express = require('express');
const db = require('../config/db');
const rules = require('../config/listings');
const blog = require('../services/blog');
const listings = require('../services/listings');
const plans = require('../services/plans');
const pricing = require('../services/pricing');
const inquiries = require('../services/inquiries');
const images = require('../services/images');
const markdown = require('../services/markdown');
const seo = require('../services/seo');
const siteContent = require('../services/siteContent');
const platformSettings = require('../services/platformSettings');
const money = require('../services/money');
const billing = require('../config/billing');
const { TRIAL_DAYS } = require('../services/contractDates');
const { wrap, publicPage, privatePage, hourly, notFound } = require('./publicHelpers');

const router = express.Router();
const contactIp = hourly('contact-ip', rules.CONTACT_PER_IP_PER_HOUR, (req) => req.ip);

async function planCards() {
  const list = await plans.listPlans(db.pool, { onlyBuyable: true });
  return list.map((p) => ({
    name: p.name_ar,
    monthly: pricing.planPrice(p, 'monthly'),
    yearly: pricing.planPrice(p, 'yearly'),
    limits: plans.usageRows(p, { units: 0, contracts: 0, members: 0, aiReads: 0, photos: 0, listings: 0 }).map((r) => ({ label: r.label, unit: r.unit, limit: r.limit })),
    features: Object.entries(plans.normalizeFeatures(p.features)).map(([flag, on]) => ({ label: plans.FEATURE_FLAGS[flag], on })),
  }));
}

const shared = () => ({ fmt: money.formatHalalas, trialDays: TRIAL_DAYS, vatPercent: billing.VAT_RATE_BP / 100 });

// ------------------------------------------------------------ home and pages

router.get('/', wrap(async (req, res) => {
  const base = publicPage(req, res, {
    description: 'عقدي يساعد مكاتب العقار على متابعة عقود الإيجار ومواعيد التجديد والدفعات، ويذكّر الملاك والمستأجرين قبل كل موعد مهم.',
    jsonLd: { '@context': 'https://schema.org', '@type': 'Organization', name: 'عقدي', url: seo.baseUrl(req) },
  });
  return res.render('site/home', { ...shared(), title: 'عقدي', metaTitle: 'عقدي | متابعة عقود الإيجار ومواعيدها لمكاتب العقار', plans: await planCards(), faqs: await siteContent.faqs(db.pool), base });
}));

router.get('/features', (req, res) => {
  publicPage(req, res, { description: 'مزايا عقدي: مواعيد التجديد، تتبع الدفعات، الصيانة، الرسائل، التقارير، والإعلانات العامة بخصوصية كاملة.' });
  return res.render('site/features', { title: 'المزايا' });
});

router.get('/pricing', wrap(async (req, res) => {
  publicPage(req, res, { description: 'باقات عقدي لمكاتب العقار: أسعار شهرية وسنوية قبل ضريبة القيمة المضافة، وتجربة مجانية.' });
  return res.render('site/pricing', { ...shared(), title: 'الأسعار', plans: await planCards(), faqs: await siteContent.faqs(db.pool) });
}));

router.get('/about', wrap(async (req, res) => {
  publicPage(req, res, { description: 'من نحن: عقدي تطبيق خاص يساعد مكاتب العقار على تنظيم مواعيد عقود الإيجار.' });
  return res.render('site/about', { title: 'من نحن', seller: await platformSettings.seller(), support: await platformSettings.support() });
}));

for (const [path, view, title, description] of [
  ['/privacy', 'privacy', 'سياسة الخصوصية', 'سياسة الخصوصية في عقدي: ما نحفظه وما لا نحفظه.'],
  ['/terms', 'terms', 'شروط الاستخدام', 'شروط استخدام تطبيق عقدي.'],
  ['/disclaimer', 'disclaimer', 'إخلاء المسؤولية', 'عقدي تطبيق خاص غير تابع لمنصة إيجار، والتواريخ للتذكير فقط.'],
]) {
  router.get(path, wrap(async (req, res) => {
    publicPage(req, res, { description });
    return res.render(`site/${view}`, { title, seller: await platformSettings.seller(), support: await platformSettings.support() });
  }));
}

// ------------------------------------------------------------ contact

async function renderContact(req, res, { values = {}, errors = {}, status = 200, sent = false } = {}) {
  if (status !== 200 || sent) privatePage(res);
  else publicPage(req, res, { description: 'تواصل مع فريق عقدي لأي سؤال عن التطبيق أو الاشتراك أو الإعلانات.' });
  return res.status(status).render('site/contact', { title: 'تواصل معنا', values, errors, sent, support: await platformSettings.support() });
}

router.get('/contact', wrap((req, res) => renderContact(req, res, { sent: req.query.sent === '1' })));

router.post('/contact', contactIp, wrap(async (req, res) => {
  const { values, errors, bot } = inquiries.validateContact(req.body, { messageMax: 1000, messageRequired: true });
  if (bot) return res.redirect('/contact?sent=1');
  if (Object.keys(errors).length) {
    return renderContact(req, res, { values: { name: values.name, phone: String(req.body.phone || '').slice(0, 30), email: String(req.body.email || '').slice(0, 190), message: values.message }, errors, status: 422 });
  }
  await inquiries.createContactMessage(db.pool, { values });
  return res.redirect('/contact?sent=1');
}));

// ------------------------------------------------------------ blog

router.get('/blog', wrap(async (req, res) => {
  const result = await blog.listPublished(db.pool, { page: req.query.page });
  const base = publicPage(req, res, { description: 'مقالات عقدي: كيف تتابع مواعيد عقود الإيجار وتنظم عملك في مكتب العقار.', page: result.page });
  res.locals.rssUrl = seo.absolute(base, '/blog/feed.xml');
  return res.render('site/blog', { title: 'المدونة', ...result });
}));

router.get('/blog/feed.xml', wrap(async (req, res) => {
  const base = seo.baseUrl(req);
  const { rows } = await blog.listPublished(db.pool, { page: 1 });
  res.set({ 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
  return res.send(seo.rssXml({
    base,
    title: 'مدونة عقدي',
    description: 'مقالات عقدي لمكاتب العقار',
    items: rows.map((p) => ({ title: p.title, link: seo.absolute(base, `/blog/${p.slug}`), description: p.excerpt || markdown.plain(p.body, 280), date: p.publishedAt })),
  }));
}));

router.get('/blog/:slug/cover', wrap(async (req, res) => {
  const name = await blog.coverFor(db.pool, req.params.slug);
  const file = name ? images.imagePath(name) : null;
  if (!file) return res.status(404).type('text/plain').send('Not found');
  res.set({ 'Content-Type': 'image/jpeg', 'X-Content-Type-Options': 'nosniff' });
  return res.sendFile(file, { dotfiles: 'allow', etag: true, lastModified: true, cacheControl: false, headers: { 'Cache-Control': 'public, max-age=86400' } }, (err) => {
    if (err && !res.headersSent) res.status(404).type('text/plain').send('Not found');
  });
}));

router.get('/blog/:slug', wrap(async (req, res) => {
  const post = await blog.getPublished(db.pool, req.params.slug);
  if (!post) return notFound(res);
  const base = seo.baseUrl(req);
  const cover = post.hasCover ? seo.absolute(base, `/blog/${post.slug}/cover`) : null;
  publicPage(req, res, {
    description: post.metaDescription || post.excerpt || markdown.plain(post.body, 160),
    ogImage: cover,
    ogType: 'article',
    jsonLd: {
      '@context': 'https://schema.org', '@type': 'BlogPosting', headline: post.title, datePublished: new Date(post.publishedAt).toISOString(),
      dateModified: new Date(post.updatedAt).toISOString(), inLanguage: 'ar', url: seo.absolute(base, `/blog/${post.slug}`), ...(cover ? { image: cover } : {}),
      publisher: { '@type': 'Organization', name: 'عقدي' },
    },
  });
  res.locals.metaTitle = post.metaTitle || post.title;
  res.locals.rssUrl = seo.absolute(base, '/blog/feed.xml');
  return res.render('site/post', { title: post.title, post, cover });
}));

// ------------------------------------------------------------ sitemap and robots

router.get('/sitemap.xml', wrap(async (req, res) => {
  const base = seo.baseUrl(req);
  const [index, posts] = await Promise.all([listings.publicIndex(db.pool), blog.publishedIndex(db.pool)]);
  res.set({ 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
  return res.send(seo.sitemapXml(base, [
    ...siteContent.PUBLIC_PAGES,
    ...index.map((l) => ({ path: `/listings/${l.id}`, lastmod: l.updatedAt, changefreq: 'weekly', priority: '0.7' })),
    ...posts.map((p) => ({ path: `/blog/${p.slug}`, lastmod: p.updated_at || p.published_at, changefreq: 'monthly', priority: '0.5' })),
  ]));
}));

router.get('/robots.txt', (req, res) => {
  res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
  return res.send(seo.robotsTxt(seo.baseUrl(req)));
});

module.exports = router;
module.exports.limiters = { contactIp };
