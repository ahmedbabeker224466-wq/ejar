'use strict';

// Builds the Express app. server.js starts it; tests import it directly.

require('dotenv').config({ quiet: true });

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const expressLayouts = require('express-ejs-layouts');

const { createAssetVersion } = require('./services/assetVersion');
const routes = require('./routes');
const authRoutes = require('./routes/auth');
const adminLoginRoutes = require('./routes/adminLogin');
const areaRoutes = require('./routes/areas');
const officeRoutes = require('./routes/office');
const officePage = require('./routes/officePage');
const customDomainRoutes = require('./routes/customDomain');
const { hostResolver } = require('./middleware/customHost');
const { loadUser, loadUnreadCount } = require('./middleware/auth');
const maintenance = require('./middleware/maintenance');
const { locale } = require('./middleware/locale');
const { appLang } = require('./middleware/appLang');
const { siteLayout } = require('./middleware/siteLayout');
const { sameOrigin } = require('./middleware/security');
const platformSettings = require('./services/platformSettings');
const { extendCsp } = require('./services/analytics');
const notFound = require('./middleware/notFound');
const errorHandler = require('./middleware/errorHandler');

const PUBLIC_DIR = path.join(__dirname, 'public');
const assets = createAssetVersion(PUBLIC_DIR);

const app = express();
// Every view can call __(); pages that know their language replace it (middleware/locale, appLang).
app.locals.__ = (text, vars) => require('./services/tr').translate('ar', text, vars);
app.locals.lang = 'ar';
app.locals.dir = 'rtl';
app.locals.cityGroups = require('./config/saudiCities').CITY_GROUPS;
// Small line icons for the landlord and tenant pages (no user text inside).
const PORTAL_ICONS = {
  home: '<path d="M3 11 12 4l9 7v9H5v-9"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>',
  message: '<path d="M4 5h16v11H9l-5 4z"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  star: '<path d="m12 3.5 2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  doc: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M10 12h5M10 16h5"/>',
  building: '<path d="M4 21V5l8-2v18M12 9h8v12M8 8v.01M8 12v.01M8 16v.01M16 13v.01M16 17v.01M2 21h20"/>',
  alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  wallet: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M16 15h2"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
};
app.locals.picon = (name) => `<svg class="picon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${PORTAL_ICONS[name] || ''}</svg>`;
app.locals.countOf = require('./services/tr').countOf;
app.locals.riyadhDay = (at) => (at ? require('./utils/time').riyadhNow(new Date(at)).slice(0, 10) : '');
app.locals.otherCity = require('./config/saudiCities').OTHER_CITY;

// Behind Passenger every connection arrives from the local proxy (127.0.0.1),
// so the visitor's address comes from X-Forwarded-For: with 'loopback' Express
// takes the right-most entry, the one the front web server adds. When the app
// is reached directly from another machine the header is ignored. The per-IP
// login limit uses req.ip; /health/detail shows what the app sees.
app.set('trust proxy', 'loopback');

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    // 'no-referrer' (helmet's default) makes browsers send "Origin: null" on
    // form posts, which the same-origin check would reject.
    referrerPolicy: { policy: 'same-origin' },
  }),
);
// Host resolution FIRST (before cookies, sessions and the same-origin check):
// a request on an office's own domain gets req.customOffice, an unknown host
// a plain 404 (middleware/customHost.js). The raw Host header only.
app.use(hostResolver());

// The optional analytics snippet (empty by default): the page gets the sanitized
// tag and the policy allows only that provider's own origins.
app.use((req, res, next) => {
  const { snippet, origins } = platformSettings.analyticsNow();
  res.locals.analyticsSnippet = snippet;
  const csp = res.getHeader('Content-Security-Policy');
  if (snippet && typeof csp === 'string') res.setHeader('Content-Security-Policy', extendCsp(csp, origins));
  next();
});
app.use(cookieParser());
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use(express.json({ limit: '20kb' }));

// A state-changing request sent from another site is refused everywhere (webhooks and cron send no Origin).
app.use(sameOrigin);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layouts/main');

// Values every template can use.
app.use((req, res, next) => {
  res.locals.assetUrl = assets.assetUrl;
  res.locals.appUrl = process.env.APP_URL || '';
  res.locals.currentPath = req.path;
  res.locals.flash = [];
  res.locals.currentUser = null;
  res.locals.title = 'ميعاد';
  res.locals.unreadCount = 0;
  // TESTING ONLY: a red banner on every page while email sign-in without a code is on.
  next();
});

app.use(
  express.static(PUBLIC_DIR, {
    cacheControl: false,
    setHeaders(res, filePath) {
      const urlPath = '/' + path.relative(PUBLIC_DIR, filePath).split(path.sep).join('/');
      res.setHeader('Cache-Control', assets.cacheControlFor(urlPath, res.req.query.v));
    },
  }),
);

// The page language from the URL (/en/... for the English marketing pages).
app.use(locale());
// Public pages share the marketing layout (middleware/siteLayout.js).
app.use(siteLayout());

// While the self-check reports a problem, show the maintenance page instead of
// touching the database. After static files so the page keeps its CSS.
app.use(maintenance);

// An office's own domain: its public page, listings, sitemap and robots only;
// everything else answers 302 to the main host. Before sessions, so no session
// or login cookie is ever read or set on a custom domain.
app.use(customDomainRoutes);

// After static files, so serving CSS/JS never touches the database.
// Never on a custom domain (e.g. /health there): no session is read or cleared.
const sessionUser = loadUser();
const unread = loadUnreadCount();
app.use(function loadUserMiddleware(req, res, next) {
  return req.isCustomHost ? next() : sessionUser(req, res, next);
});
app.use(function loadUnreadCountMiddleware(req, res, next) {
  return req.isCustomHost ? next() : unread(req, res, next);
});

// The language of every page without an /en copy: ?lang=, the user's saved
// language, the cookie, Arabic (middleware/appLang).
app.use(appLang({ saveLocale: (userId, lang) => require('./config/db').pool.query('UPDATE users SET locale = ? WHERE id = ?', [lang, userId]) }));

// The platform admin's banner message (empty = none), read from memory.
app.use((req, res, next) => {
  res.locals.platformBanner = platformSettings.bannerNow();
  res.locals.legalReviewed = platformSettings.legalReviewedNow();
  res.locals.blogLive = platformSettings.blogLiveNow();
  next();
});

app.use(adminLoginRoutes);
app.use(routes);
app.use(authRoutes);
app.use(officeRoutes);
app.use(areaRoutes);
// The office public page /<slug>: LAST, so it never shadows a real route.
app.use(officePage);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
