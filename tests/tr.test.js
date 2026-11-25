'use strict';

// services/tr.js: the app's own Arabic text in English (Nov 2026). Pure.

const test = require('node:test');
const assert = require('node:assert/strict');
const tr = require('../services/tr');

test('exact keys, templates, multi-line text and Latin digits', () => {
  assert.equal(tr.translate('en', 'العقود'), 'Contracts');
  assert.equal(tr.translate('en', 'باقي 12 يوم'), '12 days left');
  assert.equal(tr.translate('en', 'رمز الدخول إلى ميعاد: 123456\nصالح لمدة 5 دقائق. لا تشاركه مع أحد.'), 'Your Mi3aad sign-in code: 123456\nValid for 5 minutes. Do not share it with anyone.');
  assert.equal(tr.translate('en', '{0}/{1}/{2} هـ'.replace('{0}', '١٤٤٩').replace('{1}', '٠١').replace('{2}', '١٧')), '1449/01/17 AH');
});

test('Arabic stays as it is, and the user\'s own text is never changed', () => {
  assert.equal(tr.translate('ar', 'العقود'), 'العقود');
  assert.equal(tr.translate('en', 'فيلا دوبلكس، حي الياسمين'), 'فيلا دوبلكس، حي الياسمين');
  assert.equal(tr.translate('en', 'تعديل شقة 4'), 'Edit شقة 4');
  assert.equal(tr.translate('en', 42), 42);
  assert.equal(tr.translate('en', null), null);
});

test('every English value keeps the placeholders of its Arabic key', () => {
  const dict = require('../locales/en.json');
  for (const [ar, en] of Object.entries(dict)) {
    const want = (ar.match(/\{[A-Za-z0-9_]+\}/g) || []).sort().join();
    const got = (en.match(/\{[A-Za-z0-9_]+\}/g) || []).sort().join();
    assert.equal(got, want, ar);
  }
});

test('Arabic counted nouns follow the number', () => {
  const { arCount, translate } = require('../services/tr');
  assert.equal(arCount(1, 'يوم'), 'يوم واحد');
  assert.equal(arCount(2, 'يوم'), 'يومان');
  assert.equal(arCount(7, 'يوم'), '7 أيام');
  assert.equal(arCount(67, 'يوم'), '67 يوماً');
  assert.equal(arCount(100, 'يوم'), '100 يوم');
  assert.equal(arCount(208, 'يوم'), '208 أيام');
  assert.equal(translate('ar', '4 دفعة، المجموع'), '4 دفعات، المجموع');
  assert.equal(translate('ar', 'دفعة 1 · 2026-02-01'), 'دفعة 1 · 2026-02-01');
  assert.equal(translate('en', 'باقي 7 يوم'), '7 days left');
});
