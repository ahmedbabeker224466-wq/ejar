'use strict';

// Test helpers: start the app, sign in with a phone code like a person would,
// register offices and add members. Used by database tests only.

const assert = require('node:assert/strict');

function createOfficeHttp(db) {
  let server;
  let base;

  async function start() {
    const app = require('../../app');
    server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;
  }

  function stop() {
    if (server) server.close();
  }

  async function request(path, { cookie, method = 'GET', form } = {}) {
    const headers = { Origin: base };
    if (cookie) headers.Cookie = cookie;
    let body;
    if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(form)) {
        for (const item of Array.isArray(value) ? value : [value]) params.append(key, item);
      }
      body = params.toString();
    }
    const response = await fetch(`${base}${path}`, { method, headers, body, redirect: 'manual' });
    return { status: response.status, location: response.headers.get('location'), text: await response.text(), response };
  }

  async function login(phone) {
    const { hashCode } = require('../../services/otp');
    const auth = require('../../services/auth');
    await db.pool.query('DELETE FROM otp_codes WHERE phone = ?', [phone]);
    await db.pool.query(
      "INSERT INTO otp_codes (phone, code_hash, purpose, expires_at) VALUES (?, ?, 'login', UTC_TIMESTAMP() + INTERVAL 5 MINUTE)",
      [phone, hashCode(phone, '123456')],
    );
    const step = auth.signStepToken({ phone, sentAt: Date.now() }, 'login-phone', 600);
    const result = await request('/login/verify', { method: 'POST', cookie: `aqdi_login=${step}`, form: { code: '123456' } });
    const setCookie = result.response.headers.getSetCookie().find((c) => c.startsWith('aqdi_session='));
    return { location: result.location, cookie: setCookie ? setCookie.split(';')[0] : null };
  }

  async function userByPhone(phone) {
    const [[user]] = await db.pool.query('SELECT * FROM users WHERE phone = ?', [phone]);
    return user;
  }

  async function registerOffice(phone, name) {
    const { cookie } = await login(phone);
    const created = await request('/office/new', {
      method: 'POST',
      cookie,
      form: { name, city: 'الرياض', phone: '0112345678' },
    });
    assert.equal(created.status, 302, created.text.slice(0, 200));
    const user = await userByPhone(phone);
    const [[office]] = await db.pool.query('SELECT * FROM offices WHERE owner_id = ?', [user.id]);
    return { cookie, user, office };
  }

  async function addMember(officeId, phone, role) {
    await db.pool.query('INSERT INTO users (phone, role) VALUES (?, ?) ON DUPLICATE KEY UPDATE role = VALUES(role)', [phone, role]);
    const user = await userByPhone(phone);
    await db.pool.query('INSERT INTO office_members (office_id, user_id, role) VALUES (?, ?, ?)', [officeId, user.id, role]);
    return (await login(phone)).cookie;
  }

  return { start, stop, request, login, userByPhone, registerOffice, addMember, base: () => base };
}

module.exports = { createOfficeHttp };
