'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkLimit, unitLimitMessage, usageText } = require('../services/planLimits');

test('no limit (NULL) always fits', () => {
  assert.deepEqual(checkLimit({ limit: null, current: 5000, adding: 30 }), { ok: true, limit: null, current: 5000, remaining: null });
  assert.equal(checkLimit({ limit: undefined, current: 1 }).ok, true);
});

test('fits exactly up to the limit, never beyond', () => {
  assert.deepEqual(checkLimit({ limit: 20, current: 19, adding: 1 }), { ok: true, limit: 20, current: 19, remaining: 1 });
  assert.equal(checkLimit({ limit: 20, current: 20, adding: 1 }).ok, false);
  assert.equal(checkLimit({ limit: 20, current: 18, adding: 3 }).ok, false, 'bulk that would cross');
  assert.equal(checkLimit({ limit: 20, current: 17, adding: 3 }).ok, true);
  assert.equal(checkLimit({ limit: 20, current: 25, adding: 1 }).remaining, 0, 'over the limit after a downgrade');
  assert.equal(checkLimit({ limit: 0, current: 0, adding: 1 }).ok, false);
});

test('messages show the limit in Arabic', () => {
  assert.match(unitLimitMessage(checkLimit({ limit: 20, current: 20 })), /حد باقتك: 20 وحدة/);
  assert.match(unitLimitMessage(checkLimit({ limit: 20, current: 18, adding: 5 })), /يمكنك إضافة 2 فقط/);
  assert.equal(usageText({ limit: 20, current: 7 }), '7 من 20 وحدة');
  assert.equal(usageText({ limit: null, current: 7 }), null);
});
