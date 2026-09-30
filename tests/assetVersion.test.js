'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAssetVersion, IMMUTABLE, NO_CACHE } = require('../services/assetVersion');

function makePublicDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqdi-assets-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

test('assetUrl appends the first 10 hex characters of the md5', () => {
  const css = 'body { color: red; }';
  const dir = makePublicDir({ 'css/main.css': css });
  const expected = crypto.createHash('md5').update(css).digest('hex').slice(0, 10);

  const { assetUrl } = createAssetVersion(dir);

  assert.equal(assetUrl('/css/main.css'), `/css/main.css?v=${expected}`);
  assert.match(expected, /^[0-9a-f]{10}$/);
});

test('the fingerprint is stable for the same content', () => {
  const dir = makePublicDir({ 'css/main.css': 'a{}', 'js/app.js': 'x=1' });

  const first = createAssetVersion(dir);
  const second = createAssetVersion(dir);

  assert.equal(first.assetUrl('/css/main.css'), second.assetUrl('/css/main.css'));
  assert.equal(first.assetUrl('/js/app.js'), second.assetUrl('/js/app.js'));
});

test('the fingerprint changes when the content changes', () => {
  const before = createAssetVersion(makePublicDir({ 'css/main.css': 'a{}' }));
  const after = createAssetVersion(makePublicDir({ 'css/main.css': 'b{}' }));

  assert.notEqual(before.assetUrl('/css/main.css'), after.assetUrl('/css/main.css'));
});

test('unknown files are returned unchanged', () => {
  const { assetUrl } = createAssetVersion(makePublicDir({ 'css/main.css': 'a{}' }));
  assert.equal(assetUrl('/img/logo.png'), '/img/logo.png');
});

test('only the current fingerprint is cached as immutable', () => {
  const dir = makePublicDir({ 'css/main.css': 'a{}' });
  const { assetUrl, cacheControlFor } = createAssetVersion(dir);
  const version = new URL(assetUrl('/css/main.css'), 'http://x').searchParams.get('v');

  assert.equal(cacheControlFor('/css/main.css', version), IMMUTABLE);
  assert.equal(cacheControlFor('/css/main.css', undefined), NO_CACHE);
  assert.equal(cacheControlFor('/css/main.css', 'stale00000'), NO_CACHE);
});
