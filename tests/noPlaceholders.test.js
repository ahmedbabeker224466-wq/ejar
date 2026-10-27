'use strict';

// Fails when any view or route renders a placeholder page or "under
// construction" text. Every page an office can reach must be real.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const UNDER_CONSTRUCTION = /قيد البناء|قيد الإنشاء|قيد التطوير|تحت الإنشاء|under construction|coming soon/i;
// A render of a placeholder view, e.g. res.render('office/placeholder').
const PLACEHOLDER_RENDER = /render\(\s*['"`][^'"`]*placeholder/i;

function filesUnder(dir, ext) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full, ext));
    else if (entry.name.endsWith(ext)) out.push(full);
  }
  return out;
}

const rel = (file) => path.relative(ROOT, file);

test('no view contains "under construction" text and no view file is a placeholder', () => {
  const views = filesUnder(path.join(ROOT, 'views'), '.ejs');
  assert.ok(views.length > 50, 'the views were found');
  for (const file of views) {
    assert.doesNotMatch(path.basename(file), /placeholder/i, `${rel(file)} is a placeholder view`);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), UNDER_CONSTRUCTION, `${rel(file)} shows under-construction text`);
  }
});

test('no route or service renders a placeholder page or under-construction text', () => {
  const sources = [...filesUnder(path.join(ROOT, 'routes'), '.js'), ...filesUnder(path.join(ROOT, 'services'), '.js'), path.join(ROOT, 'app.js')];
  for (const file of sources) {
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, PLACEHOLDER_RENDER, `${rel(file)} renders a placeholder view`);
    assert.doesNotMatch(text, UNDER_CONSTRUCTION, `${rel(file)} contains under-construction text`);
  }
});

test('every office navigation item has a real route (no catch-all placeholder loop)', () => {
  const { OFFICE_NAV } = require('../middleware/loadOffice');
  const routeText = filesUnder(path.join(ROOT, 'routes'), '.js').map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  for (const item of OFFICE_NAV) {
    const literal = new RegExp(`['"\`]${item.href.replace(/\//g, '\\/')}['"\`]`);
    assert.match(routeText, literal, `${item.href} has its own route`);
  }
  assert.doesNotMatch(routeText, /OFFICE_NAV\.filter/, 'no generated routes from the navigation list');
});
