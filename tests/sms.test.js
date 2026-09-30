'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { selectDriver, sendSms } = require('../services/sms');
const { httpsPost } = require('../services/sms/httpsPost');
const unifonic = require('../services/sms/unifonic');
const msegat = require('../services/sms/msegat');

test('development defaults to the console driver', () => {
  assert.equal(selectDriver({ NODE_ENV: 'development' }).name, 'console');
});

test('production never falls back to the console driver silently', async () => {
  const driver = selectDriver({ NODE_ENV: 'production' });
  assert.equal(driver.name, 'none');
  assert.deepEqual(await driver.send('+966512345678', 'x'), {
    ok: false,
    providerRef: null,
    error: 'not_configured',
  });
});

test('SMS_PROVIDER picks the driver', () => {
  assert.equal(selectDriver({ SMS_PROVIDER: 'unifonic' }).name, 'unifonic');
  assert.equal(selectDriver({ SMS_PROVIDER: 'MSEGAT' }).name, 'msegat');
  assert.equal(selectDriver({ SMS_PROVIDER: 'console', NODE_ENV: 'production' }).name, 'console');
});

test('real drivers report missing settings instead of throwing', async () => {
  const saved = { ...process.env };
  delete process.env.SMS_API_KEY;
  delete process.env.SMS_SENDER;
  delete process.env.SMS_USERNAME;
  try {
    assert.equal((await unifonic.send('+966512345678', 'x')).error, 'not_configured');
    assert.equal((await msegat.send('+966512345678', 'x')).error, 'not_configured');
  } finally {
    Object.assign(process.env, saved);
  }
});

test('sendSms turns a throwing driver into a failed result', async () => {
  const broken = { name: 'broken', send: async () => { throw new Error('boom'); } };
  const result = await sendSms('+966512345678', 'x', broken);
  assert.equal(result.ok, false);
  assert.equal(result.providerRef, null);
});

test('httpsPost times out instead of hanging or throwing', async () => {
  // A server that accepts the connection and never answers.
  const sockets = [];
  const server = net.createServer((socket) => sockets.push(socket));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const started = Date.now();
    const result = await httpsPost(`https://127.0.0.1:${server.address().port}/`, { body: 'x', timeoutMs: 300 });
    assert.deepEqual(result, { error: 'timeout' });
    assert.ok(Date.now() - started < 3000);
  } finally {
    sockets.forEach((s) => s.destroy());
    server.close();
  }
});

test('httpsPost reports an unreachable host as an error value', async () => {
  const result = await httpsPost('https://127.0.0.1:1/', { body: 'x', timeoutMs: 2000 });
  assert.ok(result.error);
});
