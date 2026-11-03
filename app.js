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
const areaRoutes = require('./routes/areas');
const officeRoutes = require('./routes/office');
const officePage = require('./routes/officePage');
const customDomainRoutes = require('./routes/customDomain');
const { hostResolver } = require('./middleware/customHost');
const { loadUser, loadUnreadCount } = require('./middleware/auth');
const maintenance = require('./middleware/maintenance');
const { sameOrigin } = require('./middleware/security');
const platformSettings = require('./services/platformSettings');
const emailAuth = require('./services/emailAuth');
const { extendCsp } = require('./services/analytics');
const notFound = require('./middleware/notFound');
const errorHandler = require('./middleware/errorHandler');

const PUBLIC_DIR = path.join(__dirname, 'public');
const assets = createAssetVersion(PUBLIC_DIR);

const app = express();

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
  res.locals.title = 'عقدي';
  res.locals.unreadCount = 0;
  // TESTING ONLY: a red banner on every page while email sign-in without a code is on.
  res.locals.emailTestMode = emailAuth.enabled();
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

// The platform admin's banner message (empty = none), read from memory.
app.use((req, res, next) => {
  res.locals.platformBanner = platformSettings.bannerNow();
  res.locals.legalReviewed = platformSettings.legalReviewedNow();
  next();
});

app.use(routes);
app.use(authRoutes);
app.use(officeRoutes);
app.use(areaRoutes);
// The office public page /<slug>: LAST, so it never shadows a real route.
app.use(officePage);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
