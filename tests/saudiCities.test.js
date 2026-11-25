'use strict';

// City list grouped by region: every city once, Riyadh first, the region
// capitals lead their group, every name has an English entry, and the Riyadh
// rule matches only the city of Riyadh.

const test = require('node:test');
const assert = require('node:assert/strict');
const { SAUDI_CITIES, CITY_GROUPS, OTHER_CITY, CITIES, normalizeCity } = require('../config/saudiCities');
const en = require('../locales/en.json');

test('regions hold every city once, in the same order as the flat list', () => {
  const grouped = CITY_GROUPS.flatMap((g) => g.cities);
  assert.deepEqual([...grouped, OTHER_CITY], [...SAUDI_CITIES]);
  assert.equal(new Set(grouped).size, grouped.length);
  assert.equal(CITY_GROUPS.length, 13);
  assert.equal(CITY_GROUPS[0].label, 'منطقة الرياض');
  for (const name of ['الرياض', 'المجمعة', 'الخرج', 'الزلفي', 'شقراء', 'الدوادمي']) assert.ok(CITY_GROUPS[0].cities.includes(name), name);
  assert.equal(SAUDI_CITIES[0], 'الرياض');
});

test('every city and region has an English name and a unique key', () => {
  for (const g of CITY_GROUPS) {
    assert.ok(en[g.label], g.label);
    for (const c of g.cities) assert.ok(en[c], c);
  }
  assert.equal(new Set(CITIES.map((c) => c.key)).size, CITIES.length);
  for (const c of CITIES) assert.equal(normalizeCity(c.ar), c.key, c.ar);
});

test('only the city of Riyadh is "riyadh"; nearby towns keep their own key', () => {
  assert.equal(normalizeCity('الرياض'), 'riyadh');
  for (const name of ['رياض الخبراء', 'المجمعة', 'الدرعية', 'الخرج']) assert.notEqual(normalizeCity(name), 'riyadh', name);
});
