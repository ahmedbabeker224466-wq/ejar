'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSaudi, toWesternDigits, toLocal, toE164 } = require('../utils/phone');

const CANONICAL = '966512345678';

const ACCEPTED = [
  ['05XXXXXXXX', '0512345678'],
  ['5XXXXXXXX', '512345678'],
  ['9665XXXXXXXX', '966512345678'],
  ['+9665XXXXXXXX', '+966512345678'],
  ['Arabic-Indic 05', '٠٥١٢٣٤٥٦٧٨'],
  ['Arabic-Indic 5', '٥١٢٣٤٥٦٧٨'],
  ['Arabic-Indic +966', '+٩٦٦٥١٢٣٤٥٦٧٨'],
  ['Persian 05', '۰۵۱۲۳۴۵۶۷۸'],
  ['Persian 9665', '۹۶۶۵۱۲۳۴۵۶۷۸'],
  ['mixed digit scripts', '05١٢٣4567۸'],
  ['spaces', '051 234 5678'],
  ['dashes', '051-234-5678'],
  ['surrounding whitespace', '  0512345678  '],
];

const REJECTED = [
  ['empty', ''],
  ['null', null],
  ['undefined', undefined],
  ['too short', '051234567'],
  ['too long', '05123456789'],
  ['landline', '0112345678'],
  ['not starting with 5', '0412345678'],
  ['966 without the 5', '966412345678'],
  ['other country', '+971512345678'],
  ['00966 prefix', '00966512345678'],
  ['letters', '05123abc78'],
  ['plus in the middle', '05+12345678'],
  ['words', 'my number'],
];

for (const [label, input] of ACCEPTED) {
  test(`accepts ${label}`, () => {
    assert.equal(normalizeSaudi(input), CANONICAL);
  });
}

for (const [label, input] of REJECTED) {
  test(`rejects ${label}`, () => {
    assert.equal(normalizeSaudi(input), null);
  });
}

test('converts Arabic-Indic and Persian digits', () => {
  assert.equal(toWesternDigits('٠١٢٣٤٥٦٧٨٩'), '0123456789');
  assert.equal(toWesternDigits('۰۱۲۳۴۵۶۷۸۹'), '0123456789');
});

test('formats the canonical number for display and for providers', () => {
  assert.equal(toLocal(CANONICAL), '0512345678');
  assert.equal(toE164(CANONICAL), '+966512345678');
});
