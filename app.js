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
const { loadUser, loadUnreadCount } = require('./middleware/auth');
const maintenance = require('./middleware/maintenance');
const platformSettings = require('./services/platformSettings');
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
app.use(cookieParser());
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use(express.json({ limit: '20kb' }));

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

// After static files, so serving CSS/JS never touches the database.
app.use(loadUser());
app.use(loadUnreadCount());

// The platform admin's banner message (empty = none), read from memory.
app.use((req, res, next) => {
  res.locals.platformBanner = platformSettings.bannerNow();
  next();
});

app.use(routes);
app.use(authRoutes);
app.use(officeRoutes);
app.use(areaRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
