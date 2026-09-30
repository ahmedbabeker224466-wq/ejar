'use strict';

// Pure parts of invites: code normalisation, status, share link, the guard's
// counter, and invite expiry. Database behaviour is in landlordsFlow.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCode, inviteStatus, inviteShareLink, REASONS } = require('../services/invites');
const { inviteExpiresAt } = require('../services/contractDates');
const { createCounter } = require('../middleware/rateLimit');
const { maskPhone } = require('../utils/phone');

test('codes are trimmed, upper-cased, and spaces and dashes removed', () => {
  assert.equal(normalizeCode('abcd2345'), 'ABCD2345');
  assert.equal(normalizeCode('  AbCd-2345 '), 'ABCD2345');
  assert.equal(normalizeCode('ab cd 23 45'), 'ABCD2345');
  assert.equal(normalizeCode('ABCD–2345'), 'ABCD2345', 'en dash');
  assert.equal(normalizeCode('ABCD٢٣٤٥'), 'ABCD2345', 'Arabic digits');
});

test('look-alike characters are rejected, not mapped', () => {
  for (const bad of ['ABCD2340', 'ABCDO345', 'ABCD1345', 'ABCDI345', 'ABCDL345']) {
    assert.equal(normalizeCode(bad), null, bad);
  }
});

test('malformed input is rejected', () => {
  for (const bad of [null, undefined, '', 'ABC', 'ABCD23456', 'ABCD234!', 'ABCD 234', {}, 'ابجدهوزح']) {
    assert.equal(normalizeCode(bad), null, String(bad));
  }
});

test('invite status: used beats revoked beats expired', () => {
  const now = new Date('2026-09-30T10:00:00Z');
  const future = new Date('2026-10-30T10:00:00Z');
  const past = new Date('2026-09-30T09:59:59Z');
  assert.equal(inviteStatus({ expires_at: future }, now), 'active');
  assert.equal(inviteStatus({ expires_at: past }, now), 'expired');
  assert.equal(inviteStatus({ expires_at: now }, now), 'expired', 'expired at the exact second');
  assert.equal(inviteStatus({ expires_at: future, revoked_at: past }, now), 'revoked');
  assert.equal(inviteStatus({ expires_at: past, used_at: past, revoked_at: past }, now), 'used');
  assert.deepEqual(REASONS, ['not_found', 'expired', 'used', 'revoked']);
});

test('invites expire 30 days after creation', () => {
  assert.equal(inviteExpiresAt(new Date('2026-09-30T10:00:00Z')).toISOString(), '2026-10-30T10:00:00.000Z');
});

test('the WhatsApp link carries the code and the join page', () => {
  const link = inviteShareLink({ code: 'ABCD2345', officeName: 'مكتب النخبة', baseUrl: 'https://aqdi.sa', phone: '966501234567' });
  assert.ok(link.startsWith('https://wa.me/966501234567?text='));
  const text = decodeURIComponent(link.split('?text=')[1]);
  assert.match(text, /ABCD2345/);
  assert.match(text, /https:\/\/aqdi\.sa\/join/);
  assert.match(text, /مكتب النخبة/);
  const noPhone = inviteShareLink({ code: 'ABCD2345', officeName: 'م', baseUrl: 'https://aqdi.sa', phone: null });
  assert.ok(noPhone.startsWith('https://wa.me/?text='));
});

test('phone masking shows only the start and the end', () => {
  assert.equal(maskPhone('966501234567'), '050****567');
  assert.equal(maskPhone(null), '****');
});

test('the counter allows max events per window, then says how long to wait', () => {
  const counter = createCounter({ windowMs: 60000, max: 3 });
  const t = 1000000;
  for (let i = 0; i < 3; i += 1) {
    assert.equal(counter.retryAfter('k', t), 0);
    counter.hit('k', t);
  }
  assert.equal(counter.retryAfter('k', t + 1000), 59);
  assert.equal(counter.retryAfter('other', t), 0, 'keys are separate');
  assert.equal(counter.retryAfter('k', t + 60000), 0, 'the window slides');
});
