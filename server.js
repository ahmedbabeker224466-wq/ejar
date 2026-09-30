'use strict';

require('dotenv').config({ quiet: true });

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const expressLayouts = require('express-ejs-layouts');

const db = require('./config/db');
const logger = require('./utils/logger');
const { createAssetVersion } = require('./services/assetVersion');
const routes = require('./routes');
const authRoutes = require('./routes/auth');
const areaRoutes = require('./routes/areas');
const { loadUser } = require('./middleware/auth');
const notFound = require('./middleware/notFound');
const errorHandler = require('./middleware/errorHandler');

const PUBLIC_DIR = path.join(__dirname, 'public');
const assets = createAssetVersion(PUBLIC_DIR);

const app = express();

// cPanel runs the app behind a local reverse proxy; trust it (and only it) so
// req.ip is the visitor's address, which the per-IP login limit relies on.
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

// After static files, so serving CSS/JS never touches the database.
app.use(loadUser());

app.use(routes);
app.use(authRoutes);
app.use(areaRoutes);

app.use(notFound);
app.use(errorHandler);

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    logger.error('JWT_SECRET is missing or shorter than 32 characters: nobody can sign in');
  }
  if ((process.env.SMS_PROVIDER || '').toLowerCase() === 'console' && process.env.NODE_ENV === 'production') {
    logger.warn('SMS_PROVIDER=console in production: login codes are written to the log, not sent');
  }
  db.ensureSchema().finally(() => {
    app.listen(port, () => logger.info(`Aqdi listening on port ${port}`));
  });
}

module.exports = app;
