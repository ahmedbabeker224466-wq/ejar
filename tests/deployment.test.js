'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { checkEnv, describeSms, formatReport } = require('../services/selfCheck');

const ROOT = path.join(__dirname, '..');
const GOOD_ENV = {
  DB_USER: 'u',
  DB_NAME: 'n',
  DB_PASSWORD: 'p',
  JWT_SECRET: 'x'.repeat(40),
  SECRET_BOX_KEY: 'a'.repeat(64),
  APP_URL: 'https://example.sa',
  CRON_SECRET: 'c',
  PLATFORM_ADMIN_PHONE: '0500000000',
};

test('checkEnv passes a complete configuration', () => {
  const result = checkEnv(GOOD_ENV);
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.warnings, []);
});

test('checkEnv names exactly the missing variables', () => {
  const { DB_NAME, JWT_SECRET, ...rest } = GOOD_ENV;
  const result = checkEnv({ ...rest, DB_USER: '   ' });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['DB_USER', 'DB_NAME', 'JWT_SECRET']);
});

test('checkEnv flags malformed secrets without printing them', () => {
  const result = checkEnv({ ...GOOD_ENV, JWT_SECRET: 'short', SECRET_BOX_KEY: 'not-hex' });
  assert.deepEqual(result.invalid, ['JWT_SECRET (at least 32 characters)', 'SECRET_BOX_KEY (64 hex characters)']);
  assert.ok(!JSON.stringify(result).includes('not-hex'));
});

test('checkEnv warns about SMS settings the chosen provider needs', () => {
  const result = checkEnv({ ...GOOD_ENV, SMS_PROVIDER: 'msegat', SMS_API_KEY: 'k' });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => w.startsWith('SMS_USERNAME')));
  assert.ok(result.warnings.some((w) => w.startsWith('SMS_SENDER')));
});

test('REQUIRE_ADMIN_2FA=false in production is reported as ignored', () => {
  const prod = checkEnv({ ...GOOD_ENV, NODE_ENV: 'production', REQUIRE_ADMIN_2FA: 'false' });
  assert.equal(prod.ignored.length, 1);
  assert.match(prod.ignored[0], /REQUIRE_ADMIN_2FA=false was ignored/);
  assert.ok(!prod.warnings.some((w) => w.includes('REQUIRE_ADMIN_2FA')));

  const dev = checkEnv({ ...GOOD_ENV, NODE_ENV: 'development', REQUIRE_ADMIN_2FA: 'false' });
  assert.deepEqual(dev.ignored, []);
  assert.ok(dev.warnings.some((w) => w.includes('testing only')));

  assert.deepEqual(checkEnv({ ...GOOD_ENV, NODE_ENV: 'production' }).ignored, []);
});

test('the self-check says whether SMS is console or a real provider', () => {
  assert.equal(describeSms({ SMS_PROVIDER: 'console' }).driver, 'console');
  assert.equal(describeSms({ SMS_PROVIDER: 'unifonic' }).real, true);
  assert.equal(describeSms({ NODE_ENV: 'production' }).driver, 'none');
});

test('the report block never contains secret values', () => {
  const env = { ...GOOD_ENV, JWT_SECRET: 'super-secret-value-that-must-not-leak-000' };
  const block = formatReport({
    node: 'v20.0.0',
    nodeEnv: 'production',
    env: checkEnv(env),
    database: { connected: true, error: null },
    schema: { ok: true, found: 59, created: 0, total: 59, error: null },
    sms: describeSms({ SMS_PROVIDER: 'console' }),
    maintenance: false,
    reasons: [],
  });
  assert.match(block, /Aqdi self-check/);
  assert.match(block, /59\/59 tables \(0 created now\)/);
  assert.match(block, /SMS driver   : console/);
  assert.match(block, /Status       : SERVING/);
  assert.ok(!block.includes('super-secret-value'));
});

// ------------------------------------------------------------ app behaviour
const app = require('../app');
const runtime = require('../services/runtimeState');

// The health routes open real database connections when DB_* is set; close the
// pool so this test process can exit.
test.after(() => require('../config/db').pool.end());

async function get(pathname, headers = {}) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, { headers });
    return { status: response.status, headers: response.headers, text: await response.text() };
  } finally {
    server.close();
  }
}

test('maintenance mode serves the Arabic page but keeps health checks and CSS', async () => {
  runtime.setReport({ maintenance: true, reasons: ['test'] });
  try {
    const home = await get('/');
    assert.equal(home.status, 503);
    assert.match(home.text, /الموقع تحت الصيانة/);
    assert.equal(home.headers.get('retry-after'), '120');
    assert.equal((await get('/login')).status, 503);
    assert.equal((await get('/css/main.css')).status, 200);
    const health = await get('/health');
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.text).status, 'maintenance');
  } finally {
    runtime.setReport({ maintenance: false, reasons: [] });
  }
});

test('/health/detail needs the CRON_SECRET header', async () => {
  const saved = process.env.CRON_SECRET;
  try {
    delete process.env.CRON_SECRET;
    assert.equal((await get('/health/detail', { 'X-Cron-Secret': '' })).status, 403, 'disabled when unset');
    process.env.CRON_SECRET = 'right-secret';
    assert.equal((await get('/health/detail')).status, 403);
    assert.equal((await get('/health/detail', { 'X-Cron-Secret': 'wrong' })).status, 403);
    const ok = await get('/health/detail', { 'X-Cron-Secret': 'right-secret' });
    assert.equal(ok.status, 200);
    const body = JSON.parse(ok.text);
    assert.ok(body.live.node);
    assert.ok(!ok.text.includes('right-secret'));
  } finally {
    if (saved === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = saved;
  }
});

test('middleware runs in the required order', () => {
  const names = app._router.stack.map((layer) => layer.name);
  const order = [
    'helmetMiddleware',
    'cookieParser',
    'urlencodedParser',
    'jsonParser',
    'serveStatic',
    'maintenance',
    'loadUserMiddleware',
    'router',
    'notFound',
    'errorHandler',
  ];
  let last = -1;
  for (const name of order) {
    const index = names.indexOf(name);
    assert.ok(index > last, `${name} is out of order: ${names.join(' > ')}`);
    last = index;
  }
  assert.equal(names.at(-1), 'errorHandler', 'the error handler is last');
  assert.equal(names.filter((n) => n === 'router').length, 3, 'index, auth and area routers are mounted');
});

test('forwarding headers are trusted only from a local proxy', () => {
  assert.equal(app.get('trust proxy'), 'loopback');
  const trust = app.get('trust proxy fn');
  assert.equal(trust('127.0.0.1', 0), true);
  assert.equal(trust('203.0.113.7', 0), false, 'a visitor cannot set X-Forwarded-For');
});

test('every application module loads, so no import points at a missing file', () => {
  const dirs = ['config', 'database', 'middleware', 'routes', 'services', 'services/sms', 'utils', 'deploy'];
  const skip = new Set(['deploy/restart.js', 'database/seed.js']); // scripts with side effects
  for (const dir of dirs) {
    for (const file of fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.js'))) {
      const rel = `${dir}/${file}`;
      if (skip.has(rel)) {
        // Still check their imports resolve.
        const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        for (const [, spec] of source.matchAll(/require\('(\.[^']+)'\)/g)) {
          assert.doesNotThrow(() => require.resolve(path.join(ROOT, dir, spec)), `${rel} -> ${spec}`);
        }
        continue;
      }
      assert.doesNotThrow(() => require(path.join(ROOT, rel)), rel);
    }
  }
});

test('every view that routes render exists', () => {
  const sources = ['routes', 'middleware'].flatMap((dir) =>
    fs.readdirSync(path.join(ROOT, dir)).map((f) => fs.readFileSync(path.join(ROOT, dir, f), 'utf8')),
  );
  for (const [, view] of sources.join('\n').matchAll(/render\('([^']+)'/g)) {
    assert.ok(fs.existsSync(path.join(ROOT, 'views', `${view}.ejs`)), `views/${view}.ejs`);
  }
});

test('deployment excludes secrets, dependencies and user files', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deploy.yml'), 'utf8');
  for (const pattern of ['.env', '**/node_modules/**', 'uploads/**', 'backups/**', 'tests/**']) {
    assert.ok(workflow.includes(`\n            ${pattern}\n`), `deploy.yml must exclude ${pattern}`);
  }
  for (const secret of ['FTP_HOST', 'FTP_USER', 'FTP_PASSWORD']) {
    assert.ok(workflow.includes(`secrets.${secret}`), secret);
  }
});

test('no leftover reference to the old Next.js / Supabase / Vercel stack', () => {
  const skipDirs = new Set(['node_modules', '.git', 'reference', 'tests']);
  const offenders = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skipDirs.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|ejs|json|md|ya?ml|css|example)$/.test(entry.name) || entry.name.startsWith('.env')) {
        if (/next\.js|nextjs|supabase|vercel/i.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.relative(ROOT, full));
      }
    }
  })(ROOT);
  assert.deepEqual(offenders, []);
});
