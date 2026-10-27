'use strict';

// Slug rules of the office public link (pure), and the guard that every
// top-level path the app mounts is a reserved word, so /<slug> can never
// shadow a real page.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const link = require('../services/officeLink');

test('slug form: a-z, 0-9 and single hyphens, 3 to 40 characters, lower-cased', () => {
  for (const ok of ['abc', 'al-ittihad', 'office-2024', 'a1b2c3', 'x'.repeat(40), ' Al-Ittihad ']) {
    const r = link.validateSlug(ok);
    assert.equal(r.ok, true, `${ok}: ${r.error}`);
    assert.equal(r.slug, ok.trim().toLowerCase());
  }
  const bad = {
    '': 'empty',
    '   ': 'empty',
    ab: 'length',
    ['x'.repeat(41)]: 'length',
    'al_ittihad': 'chars',
    'al ittihad': 'chars',
    'الاتحاد': 'chars',
    'al.ittihad': 'chars',
    'café': 'chars',
    '-abc': 'hyphen',
    'abc-': 'hyphen',
    'ab--cd': 'hyphen',
    '../etc': 'chars',
  };
  for (const [input, error] of Object.entries(bad)) assert.equal(link.validateSlug(input).error, error, JSON.stringify(input));
  for (const code of Object.keys(link.ERRORS)) assert.match(link.ERRORS[code], /[؀-ۿ]/, `${code} is Arabic`);
});

test('reserved words and the fixed list are refused, in any case', () => {
  for (const word of ['admin', 'office', 'platform', 'login', 'logout', 'join', 'health', 'api', 'static', 'public', 'listings', 'blog',
    'pricing', 'features', 'about', 'contact', 'terms', 'privacy', 'disclaimer', 'landlord', 'tenant', 'billing', 'www', 'aqdi', 'ejar',
    'support', 'help', 'rega', 'zatca', 'gov', 'official', 'ADMIN', 'Blog', 'healthz', 'webhooks', 'cron', 'css', 'js']) {
    const r = link.validateSlug(word);
    assert.equal(r.ok, false, word);
    assert.ok(['reserved', 'official', 'length'].includes(r.error), `${word}: ${r.error}`);
  }
});

test('names that look official or impersonate a government body are refused', () => {
  for (const name of ['ejar-riyadh', 'myejar', 'rega-office', 'moj', 'moj-services', 'nafath', 'absher-help', 'balady-jeddah', 'zatca-sa',
    'saudi-gov', 'gov-sa', 'ministry-housing', 'official-ejar', 'eijar', 'tawakkalna']) {
    assert.equal(link.validateSlug(name).error, 'official', name);
  }
  for (const name of ['al-ittihad', 'regal-homes', 'mojave', 'governor-street', 'riyadh-homes']) {
    assert.equal(link.validateSlug(name).ok, true, name);
  }
});

test('automatic slugs are office-xxxxxx, valid and random', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const slug = link.randomSlug();
    assert.match(slug, /^office-[a-z0-9]{6}$/);
    seen.add(slug);
  }
  assert.ok(seen.size > 190);
});

test('the public-page form: description up to 300 characters, plain text, no contact details', () => {
  assert.deepEqual(link.validatePageFields({ enabled: '1', description: '  مكتب عقاري في الرياض  ' }), { values: { enabled: true, description: 'مكتب عقاري في الرياض' }, errors: {} });
  assert.deepEqual(link.validatePageFields({}).values, { enabled: false, description: null });
  assert.ok(link.validatePageFields({ description: 'x'.repeat(301) }).errors.description);
  assert.ok(link.validatePageFields({ description: 'اتصل 0551234567' }).errors.description);
  assert.ok(link.validatePageFields({ description: 'www.example.com' }).errors.description);
});

// ------------------------------------------------------------ reserved words vs mounted routes

/** First path segments of every route and mounted path in an Express router stack. */
function topSegments(stack, out = new Set(), params = []) {
  for (const layer of stack) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const p of paths) {
        if (typeof p !== 'string') throw new Error(`a route path is not a string (${p}); add its top-level word to the reserved list by hand and extend this test`);
        const first = p.split('/')[1] || '';
        if (first.startsWith(':')) params.push({ path: p, layer });
        else if (first) out.add(first);
      }
    } else if (layer.handle && Array.isArray(layer.handle.stack)) {
      topSegments(layer.handle.stack, out, params);
    }
  }
  return { segments: out, params };
}

test('every top-level path the app mounts, and every public/ folder, is a reserved slug', () => {
  const app = require('../app');
  const { segments, params } = topSegments(app._router.stack);
  for (const dir of fs.readdirSync(path.join(__dirname, '..', 'public'))) segments.add(dir);
  assert.ok(segments.size > 20, 'the routes were found');
  const missing = [...segments].map((s) => s.split('.')[0].toLowerCase()).filter((s) => !link.RESERVED.has(s));
  assert.deepEqual(missing, [], `add these to MOUNTED in services/officeLink.js: ${missing.join(', ')}`);

  // The only top-level parameter route is the office page, and it is the last handler before the 404.
  assert.deepEqual(params.map((p) => p.path), ['/:slug']);
  const names = app._router.stack.map((l) => l.name);
  const pageIndex = app._router.stack.findIndex((l) => l.handle && Array.isArray(l.handle.stack) && l.handle.stack.some((x) => x.route && x.route.path === '/:slug'));
  assert.equal(pageIndex, names.length - 3, 'the office page router comes right before notFound and errorHandler');
  assert.equal(names[names.length - 2], 'notFound');
});
