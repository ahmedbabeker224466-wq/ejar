'use strict';

const https = require('https');

/**
 * POST with a hard timeout. Never throws: resolves to
 * { status, body } on any HTTP response, or { error } on network failure.
 */
function httpsPost(url, { headers = {}, body = '', timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    let request;
    try {
      request = https.request(
        url,
        { method: 'POST', headers: { 'Content-Length': Buffer.byteLength(body), ...headers } },
        (response) => {
          let data = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            if (data.length < 64 * 1024) data += chunk; // providers reply briefly
          });
          response.on('end', () => finish({ status: response.statusCode, body: data }));
          response.on('error', (err) => finish({ error: err.code || 'response_error' }));
        },
      );
    } catch (err) {
      finish({ error: err.code || 'invalid_request' });
      return;
    }

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('timeout'));
      finish({ error: 'timeout' });
    });
    request.on('error', (err) => finish({ error: err.code || err.message || 'request_error' }));
    request.end(body);
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

module.exports = { httpsPost, parseJson };
