'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const IMMUTABLE = 'public, max-age=31536000, immutable';
const NO_CACHE = 'no-cache';

/** Every .css and .js file under dir, as absolute paths. */
function listAssets(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listAssets(full);
    return /\.(css|js)$/.test(entry.name) ? [full] : [];
  });
}

/**
 * Fingerprints the CSS/JS files in publicDir once, at startup.
 * assetUrl('/css/main.css') -> '/css/main.css?v=<first 10 hex of md5>'.
 */
function createAssetVersion(publicDir) {
  const versions = new Map();
  for (const file of listAssets(publicDir)) {
    const urlPath = '/' + path.relative(publicDir, file).split(path.sep).join('/');
    const hash = crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
    versions.set(urlPath, hash.slice(0, 10));
  }

  function assetUrl(urlPath) {
    const version = versions.get(urlPath);
    return version ? `${urlPath}?v=${version}` : urlPath;
  }

  /** Cache-Control for a static request: immutable only for the current fingerprint. */
  function cacheControlFor(urlPath, requestedVersion) {
    const version = versions.get(urlPath);
    return version && requestedVersion === version ? IMMUTABLE : NO_CACHE;
  }

  return { assetUrl, cacheControlFor, versions };
}

module.exports = { createAssetVersion, IMMUTABLE, NO_CACHE };
