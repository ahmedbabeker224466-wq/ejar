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
const notFound = require('./middleware/notFound');
const errorHandler = require('./middleware/errorHandler');

const PUBLIC_DIR = path.join(__dirname, 'public');
const assets = createAssetVersion(PUBLIC_DIR);

const app = express();

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
  }),
);
app.use(cookieParser());

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

app.use(routes);

app.use(notFound);
app.use(errorHandler);

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  db.ensureSchema().finally(() => {
    app.listen(port, () => logger.info(`Aqdi listening on port ${port}`));
  });
}

module.exports = app;
