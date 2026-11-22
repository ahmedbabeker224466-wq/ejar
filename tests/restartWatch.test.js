'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start, shouldRestart } = require('../services/restartWatch');

test('shouldRestart only fires on a newer or newly created restart file', () => {
  assert.strictEqual(shouldRestart(null, null), false);
  assert.strictEqual(shouldRestart(100, null), false);
  assert.strictEqual(shouldRestart(100, 100), false);
  assert.strictEqual(shouldRestart(100, 99), false);
  assert.strictEqual(shouldRestart(100, 101), true);
  assert.strictEqual(shouldRestart(null, 5), true);
});

test('the watcher closes the server and exits when restart.txt is touched', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-'));
  const file = path.join(dir, 'restart.txt');
  fs.writeFileSync(file, 'a');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(file, old, old);
  let closed = false;
  const exited = new Promise((resolve) => {
    start({
      file,
      checkMs: 20,
      logger: { info() {} },
      server: { close(cb) { closed = true; cb(); } },
      exit: resolve,
    });
  });
  fs.writeFileSync(file, 'b');
  // The watcher's timer is unref'd; keep the loop alive while waiting.
  const keepAlive = setTimeout(() => {}, 5000);
  const code = await exited;
  clearTimeout(keepAlive);
  assert.strictEqual(code, 0);
  assert.strictEqual(closed, true);
  fs.rmSync(dir, { recursive: true, force: true });
});
