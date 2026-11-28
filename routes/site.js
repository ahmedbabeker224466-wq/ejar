'use strict';

// The marketing site, the blog, the contact form, sitemap.xml and robots.txt.
// Everything is public, server-rendered and cached for a minute. The seller
// and support details on the legal pages come from the platform settings
// (nothing about the company is hardcoded). No page claims any affiliation
// with, approval by or compliance with Ejar, REGA or ZATCA.

const ejarRules = require('../config/ejarRules');
const emailCode = require('../services/emailCode');
const express = require('express');
const db = require('../config/db');
const rules = require('../config/listings');
const blog = require('../services/blog');
const listings = require('../services/listings');
const listingIcons = require('../services/listingIcons');
const officeLink = require('../services/officeLink');
const plans = require('../services/plans');
const pricing = require('../services/pricing');
const officialPricing = require('../services/officialPricing');
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

// The public plan cards: buyable plans (active, public, priced) from the plans table.
// `lines` are the Arabic card lines (unchanged); `spec` carries the raw limits so
// the marketing pages can word them in either language.
async function planCards() {
  const list = await plans.listPlans(db.pool, { onlyBuyable: true });
  const addon = await officialPricing.customDomainAddon(db.pool);
  return list.map((p) => {
    const monthly = pricing.planPrice(p, 'monthly');
    const yearly = pricing.planPrice(p, 'yearly');
    return {
      code: p.code, name: p.name_ar, monthly, yearly, paidMonths: officialPricing.paidMonths(monthly, yearly), lines: officialPricing.cardLines(p, addon, money.formatHalalas),
      spec: officialPricing.planSpec(p, addon),
    };
  });
}

// Structured data for the home page: who runs the site, the site itself and the
// web application it offers (no prices, they are VAT-exclusive on the page).
function homeJsonLd(req, t) {
  const base = seo.baseUrl(req);
  const url = seo.absolute(base, req.lang === 'en' ? '/en' : '/');
  return {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'Organization', '@id': `${base}/#org`, name: t('brand'), url: seo.absolute(base, '/'), logo: seo.absolute(base, '/favicon.svg') },
      { '@type': 'WebSite', '@id': `${base}/#site`, name: t('brand'), url, inLanguage: req.lang === 'en' ? 'en' : 'ar', publisher: { '@id': `${base}/#org` } },
      { '@type': 'SoftwareApplication', name: t('brand'), url, applicationCategory: 'BusinessApplication', operatingSystem: 'Web', description: t('meta.homeDescription'), publisher: { '@id': `${base}/#org` } },
    ],
  };
}

const shared = () => ({
  fmt: money.formatHalalas, trialDays: TRIAL_DAYS, vatPercent: billing.VAT_RATE_BP / 100, customFromUnits: officialPricing.CUSTOM_PLAN_FROM_UNITS,
});

// ------------------------------------------------------------ home and pages

// The home page (Nov 2026 redesign): the platform's page for real-estate offices,
// in Arabic at / and in English at /en. /offices serves the same page (older links).
router.get(['/', '/offices'], wrap(async (req, res) => {
  const t = res.locals.t;
  publicPage(req, res, {
    description: t('meta.homeDescription'),
    jsonLd: homeJsonLd(req, t),
    path: '/',
  });
  // The home page puts public listings first (owner's request, Nov 2026); the office
  // marketing page stays on /offices and takes over the home page while nothing is published.
  const onHome = req.path !== '/offices';
  const showcase = await listings.publicShowcase(db.pool, { limit: onHome ? 12 : 10, cities: onHome ? 3 : 0, themed: onHome }).catch(() => null);
  if (onHome && showcase && showcase.total) {
    return res.render('site/home-listings', {
      ...shared(),
      showcase,
      displayTitle: listings.displayTitle, discountPercent: listings.discountPercent, types: listings.TYPE_LABELS, fmt: money.formatHalalas, icon: listingIcons.icon,
      layout: 'layouts/site', mkStd: false, title: t('brand'), metaTitle: t('meta.homeTitle'),
    });
  }
  return res.render('site/landing', {
    ...shared(),
    showcase,
    displayTitle: listings.displayTitle, discountPercent: listings.discountPercent, types: listings.TYPE_LABELS, fmt: money.formatHalalas, icon: listingIcons.icon,
    rules: { noticeDays: ejarRules.NON_RENEWAL_NOTICE_DAYS, rentChangeDays: ejarRules.RENT_CHANGE_NOTICE_DAYS },
    emailSignup: emailCode.enabled(),
    layout: 'layouts/site', mkStd: false, title: t('brand'), metaTitle: t('meta.homeTitle'), plans: await planCards(), faqs: req.lang === 'en' ? [] : await siteContent.faqs(db.pool),
  });
}));

router.get('/features', (req, res) => {
  const t = res.locals.t;
  publicPage(req, res, { description: t('meta.featuresDescription') });
  return res.render('site/features', { layout: 'layouts/site', mkStd: false, title: t('meta.featuresTitle') });
});

router.get('/pricing', wrap(async (req, res) => {
  const t = res.locals.t;
  publicPage(req, res, { description: t('meta.pricingDescription') });
  return res.render('site/pricing', { ...shared(), layout: 'layouts/site', mkStd: false, title: t('meta.pricingTitle'), plans: await planCards(), faqs: req.lang === 'en' ? [] : await siteContent.faqs(db.pool) });
}));

for (const [path, view, key] of [
  ['/about', 'about', 'about'],
  ['/privacy', 'privacy', 'privacy'],
  ['/terms', 'terms', 'terms'],
  ['/disclaimer', 'disclaimer', 'disclaimer'],
]) {
  router.get(path, wrap(async (req, res) => {
    const t = res.locals.t;
    publicPage(req, res, { description: t(`meta.${key}Description`) });
    return res.render(`site/${view}`, { layout: 'layouts/site', mkStd: false, title: t(`meta.${key}Title`), seller: await platformSettings.seller(), support: await platformSettings.support() });
  }));
}

// ------------------------------------------------------------ contact

async function renderContact(req, res, { values = {}, errors = {}, status = 200, sent = false } = {}) {
  if (status !== 200 || sent) privatePage(res);
  else publicPage(req, res, { description: res.locals.t('meta.contactDescription') });
  return res.status(status).render('site/contact', { layout: 'layouts/site', mkStd: false, title: res.locals.t('meta.contactTitle'), values, errors, sent, support: await platformSettings.support() });
}

router.get('/contact', wrap((req, res) => renderContact(req, res, { sent: req.query.sent === '1' })));

router.post('/contact', contactIp, wrap(async (req, res) => {
  const { values, errors, bot } = inquiries.validateContact(req.body, { messageMax: 1000, messageRequired: true });
  if (bot) return res.redirect(`${res.locals.L('/contact')}?sent=1`);
  if (Object.keys(errors).length) {
    return renderContact(req, res, { values: { name: values.name, phone: String(req.body.phone || '').slice(0, 30), email: String(req.body.email || '').slice(0, 190), message: values.message }, errors, status: 422 });
  }
  await inquiries.createContactMessage(db.pool, { values });
  return res.redirect(`${res.locals.L('/contact')}?sent=1`);
}));

// ------------------------------------------------------------ blog

router.get('/blog', wrap(async (req, res) => {
  const result = await blog.listPublished(db.pool, { page: req.query.page });
  const base = publicPage(req, res, { description: 'مقالات ميعاد: كيف تتابع مواعيد عقود الإيجار وتنظم عملك في مكتب العقار.', page: result.page });
  res.locals.rssUrl = seo.absolute(base, '/blog/feed.xml');
  return res.render('site/blog', { title: 'المدونة', ...result });
}));

router.get('/blog/feed.xml', wrap(async (req, res) => {
  const base = seo.baseUrl(req);
  const { rows } = await blog.listPublished(db.pool, { page: 1 });
  res.set({ 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
  return res.send(seo.rssXml({
    base,
    title: 'مدونة ميعاد',
    description: 'مقالات ميعاد لمكاتب العقار',
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
      publisher: { '@type': 'Organization', name: 'ميعاد' },
    },
  });
  res.locals.metaTitle = post.metaTitle || post.title;
  res.locals.rssUrl = seo.absolute(base, '/blog/feed.xml');
  return res.render('site/post', { title: post.title, post, cover });
}));

// ------------------------------------------------------------ sitemap and robots

router.get('/sitemap.xml', wrap(async (req, res) => {
  const base = seo.baseUrl(req);
  const [index, posts, officePages] = await Promise.all([listings.publicIndex(db.pool), blog.publishedIndex(db.pool), officeLink.publicIndex(db.pool)]);
  res.set({ 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
  return res.send(seo.sitemapXml(base, [
    ...siteContent.PUBLIC_PAGES,
    ...index.map((l) => ({ path: `/listings/${l.id}`, lastmod: l.updatedAt, changefreq: 'weekly', priority: '0.7' })),
    // One page per city that has public listings (/listings?city=...).
    ...[...new Set(index.map((l) => l.city).filter(Boolean))].map((c) => ({ path: `/listings?city=${encodeURIComponent(c)}`, changefreq: 'daily', priority: '0.8' })),
    ...posts.map((p) => ({ path: `/blog/${p.slug}`, lastmod: p.updated_at || p.published_at, changefreq: 'monthly', priority: '0.5' })),
    ...officePages.map((o) => ({ path: `/${o.slug}`, lastmod: o.updatedAt, changefreq: 'weekly', priority: '0.6' })),
  ]));
}));

router.get('/robots.txt', (req, res) => {
  res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
  return res.send(seo.robotsTxt(seo.baseUrl(req)));
});

module.exports = router;
module.exports.limiters = { contactIp };
