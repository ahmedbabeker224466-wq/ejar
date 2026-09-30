'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../app');

function listen() {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

test('unknown pages render the Arabic 404 page', async () => {
  const server = await listen();
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/no-such-page`);
    const html = await response.text();

    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(html, /<html lang="ar" dir="rtl">/);
    assert.match(html, /الصفحة غير موجودة/);
  } finally {
    server.close();
  }
});
