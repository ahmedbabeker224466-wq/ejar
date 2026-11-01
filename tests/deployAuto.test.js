'use strict';

// Automatic deploy (Prompt 22): .cpanel.yml and .github/workflows/deploy.yml
// parse and hold no host, user or token; deploy/cpanel-trigger.sh against a
// fake cPanel + /health server (order of calls, auth header, readable
// failures, skip without secrets, the restart check, the token never printed);
// deploy/cpanel-deploy.sh against a fake application root (stops before
// copying when the Node.js environment is missing, never touches .env or
// uploads, restarts only after npm install succeeded).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const has = (cmd) => spawnSync('bash', ['-c', `command -v ${cmd}`]).status === 0;
const TOOLS = has('curl') && has('jq') && has('rsync') ? false : 'needs bash, curl, jq and rsync';
const PYYAML = spawnSync('python3', ['-c', 'import yaml']).status === 0;

const FILES = ['.cpanel.yml', '.github/workflows/deploy.yml', 'deploy/cpanel-deploy.sh', 'deploy/cpanel-trigger.sh'];
const TOKEN = 'TESTTOKENABCDEFGHIJKLMNOPQRSTUVWX0123';

// ------------------------------------------------------------ static checks

test('the YAML files parse and have the expected shape', { skip: PYYAML ? false : 'python3 with PyYAML not available' }, () => {
  const load = (p) => {
    const out = spawnSync('python3', ['-c', 'import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1])), default=str))', path.join(ROOT, p)], { encoding: 'utf8' });
    assert.equal(out.status, 0, `${p}: ${out.stderr}`);
    return JSON.parse(out.stdout);
  };
  const cpanel = load('.cpanel.yml');
  const tasks = cpanel.deployment.tasks;
  assert.ok(Array.isArray(tasks) && tasks.length >= 2);
  assert.match(tasks[0], /^export NODE_VERSION=\S+$/, 'NODE_VERSION is the first, single setting');
  assert.ok(tasks.includes('/bin/bash deploy/cpanel-deploy.sh'));

  const wf = load('.github/workflows/deploy.yml');
  const on = wf.on || wf.true; // YAML 1.1 reads the key "on" as true
  assert.deepEqual(on.workflow_run, { workflows: ['CI'], types: ['completed'], branches: ['main'] });
  assert.ok('workflow_dispatch' in on);
  assert.deepEqual(wf.concurrency, { group: 'deploy-cpanel', 'cancel-in-progress': false });
  const job = wf.jobs.deploy;
  assert.match(job.if, /workflow_run\.conclusion == 'success'/);
  const run = job.steps.find((s) => s.run && s.run.includes('cpanel-trigger.sh'));
  assert.deepEqual(Object.keys(run.env).sort(), ['CPANEL_API_TOKEN', 'CPANEL_HOST', 'CPANEL_USER', 'HEALTH_URL']);
  for (const k of ['CPANEL_API_TOKEN', 'CPANEL_HOST', 'CPANEL_USER']) assert.equal(run.env[k], `\${{ secrets.${k} }}`);
  assert.equal(fs.readdirSync(path.join(ROOT, '.github/workflows')).filter((f) => /deploy/i.test(f)).length, 1, 'one deploy path');
});

test('no hardcoded cPanel host, user, token or FTP left; the scripts are valid bash', () => {
  for (const f of FILES) {
    const text = read(f);
    assert.doesNotMatch(text, /web-hosting\.com|server\d+\./i, `${f}: cPanel host`);
    assert.doesNotMatch(text, /phillryi/, `${f}: cPanel user name`);
    assert.doesNotMatch(text, /\b[A-Z0-9]{32,}\b/, `${f}: token-like value`);
    assert.doesNotMatch(text, /FTP_|FTP-Deploy/, `${f}: the old FTP path`);
    assert.doesNotMatch(text, /set -x|echo .*\$\{?CPANEL_API_TOKEN/, `${f}: never prints the token`);
    assert.doesNotMatch(text, /\t/, `${f}: no tabs`);
  }
  for (const f of ['deploy/cpanel-deploy.sh', 'deploy/cpanel-trigger.sh']) {
    const out = spawnSync('bash', ['-n', path.join(ROOT, f)], { encoding: 'utf8' });
    assert.equal(out.status, 0, `${f}: ${out.stderr}`);
  }
  assert.equal(Object.keys(require('../package.json').dependencies).length, 13);
});

// ------------------------------------------------------------ trigger script

function runScript(file, { env, cwd = ROOT }) {
  return new Promise((resolve) => {
    execFile('bash', [path.join(ROOT, file)], { cwd, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, timeout: 30000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr, all: stdout + stderr });
    });
  });
}

/** A fake cPanel UAPI + /health. handlers: { update, create, health(i) } -> [status, body]. */
async function fakeServer(handlers) {
  const calls = [];
  let healthCalls = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization || null });
    let reply;
    if (url.pathname === '/execute/VersionControl/update') reply = handlers.update();
    else if (url.pathname === '/execute/VersionControlDeployment/create') reply = handlers.create();
    else if (url.pathname === '/health') reply = handlers.health(healthCalls++);
    else reply = [404, '{}'];
    res.writeHead(reply[0], { 'Content-Type': 'application/json' });
    res.end(typeof reply[1] === 'string' ? reply[1] : JSON.stringify(reply[1]));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { calls, base, close: () => server.close() };
}

const ok = (data = {}) => [200, { status: 1, errors: null, data }];
const health = (uptime, status = 'ok') => [200, { status, uptimeSeconds: uptime, database: 'reachable' }];
const env = (srv, extra = {}) => ({
  CPANEL_HOST: 'cpanel.example.test', CPANEL_USER: 'someuser', CPANEL_API_TOKEN: TOKEN,
  CPANEL_BASE_URL: srv.base, HEALTH_URL: `${srv.base}/health`, HEALTH_INTERVAL: '0', HEALTH_ATTEMPTS: '3', ...extra,
});

test('trigger: update, then deploy, then a fresh /health; the token goes only into the auth header', { skip: TOOLS }, async () => {
  const srv = await fakeServer({ update: () => ok(), create: () => ok({ deploy_id: 7 }), health: (i) => (i === 0 ? health(90000) : health(0)) });
  try {
    const r = await runScript('deploy/cpanel-trigger.sh', { env: env(srv) });
    assert.equal(r.code, 0, r.all);
    assert.deepEqual(srv.calls.map((c) => c.path), ['/execute/VersionControl/update', '/execute/VersionControlDeployment/create', '/health', '/health']);
    assert.deepEqual(srv.calls[0].query, { repository_root: '/home/someuser/aqdi-src', branch: 'main' });
    assert.deepEqual(srv.calls[1].query, { repository_root: '/home/someuser/aqdi-src' });
    assert.equal(srv.calls[0].auth, `cpanel someuser:${TOKEN}`);
    assert.equal(srv.calls[2].auth, null, 'the health check carries no credentials');
    assert.match(r.stdout, /::add-mask::cpanel\.example\.test/);
    assert.match(r.stdout, /::add-mask::someuser/);
    assert.match(r.stdout, /The app restarted after this deploy/);
    assert.ok(!r.all.includes(TOKEN), 'the token is never printed');
  } finally {
    srv.close();
  }
});

test('trigger: missing secrets skip cleanly with a notice and call nothing', { skip: TOOLS }, async () => {
  const srv = await fakeServer({ update: () => ok(), create: () => ok(), health: () => health(0) });
  try {
    for (const missing of ['CPANEL_HOST', 'CPANEL_USER', 'CPANEL_API_TOKEN']) {
      const r = await runScript('deploy/cpanel-trigger.sh', { env: env(srv, { [missing]: '' }) });
      assert.equal(r.code, 0, r.all);
      assert.match(r.stdout, /::notice::Deploy skipped/);
    }
    assert.equal(srv.calls.length, 0);
  } finally {
    srv.close();
  }
});

test('trigger: readable failures (cPanel error, refused token, no restart, maintenance)', { skip: TOOLS }, async () => {
  const cases = [
    { handlers: { update: () => [200, { status: 0, errors: ['The repository is not clean.'] }] }, expect: /VersionControl\/update: The repository is not clean\./, calls: 1 },
    { handlers: { update: () => [401, 'denied'] }, expect: /refused the API token \(HTTP 401\)/, calls: 1 },
    { handlers: { create: () => [500, 'oops'] }, expect: /VersionControlDeployment\/create: cPanel answered HTTP 500/, calls: 2 },
    { handlers: { health: () => health(90000) }, expect: /did not confirm a restart within 0 s \(last: HTTP 200, status ok, uptime 90000 s\)/, calls: 5 },
    { handlers: { health: () => health(1, 'maintenance') }, expect: /did not confirm a restart[\s\S]*status maintenance/, calls: 5 },
    { handlers: { health: () => [503, '{}'] }, expect: /did not confirm a restart.*HTTP 503/, calls: 5 },
  ];
  for (const c of cases) {
    const srv = await fakeServer({ update: () => ok(), create: () => ok(), health: () => health(0), ...c.handlers });
    try {
      const r = await runScript('deploy/cpanel-trigger.sh', { env: env(srv) });
      assert.equal(r.code, 1, r.all);
      assert.match(r.stderr, /::error::Deploy failed: /);
      assert.match(r.all, c.expect);
      assert.equal(srv.calls.length, c.calls, `${c.expect}: calls ${srv.calls.map((x) => x.path).join(', ')}`);
      assert.ok(!r.all.includes(TOKEN));
    } finally {
      srv.close();
    }
  }
});

// ------------------------------------------------------------ server-side deploy script

function fakeRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aqdi-deploy-'));
  const repo = path.join(base, 'aqdi-src');
  const app = path.join(base, 'aqdi');
  const files = {
    'package.json': '{"name":"aqdi"}', 'server.js': 'new server', 'routes/a.js': 'route', '.env': 'REPO_ENV=1',
    'tests/x.test.js': 't', 'docs/D.md': 'd', 'README.md': 'r', 'storage/uploads/p.jpg': 'repo-photo',
    'node_modules/m/index.js': 'm', '.git/HEAD': 'h', '.github/workflows/x.yml': 'w', 'backups/b.enc': 'b', 'tmp/old.txt': 'o',
  };
  for (const [p, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true });
    fs.writeFileSync(path.join(repo, p), c);
  }
  fs.copyFileSync(path.join(ROOT, 'deploy/cpanel-deploy.sh'), path.join(repo, 'deploy-script.sh'));
  fs.mkdirSync(path.join(app, 'storage/uploads'), { recursive: true });
  fs.writeFileSync(path.join(app, '.env'), 'LIVE_ENV=1');
  fs.writeFileSync(path.join(app, 'storage/uploads/live.jpg'), 'live-photo');
  fs.writeFileSync(path.join(app, 'server.js'), 'old server');
  // A fake cPanel Node.js environment: "npm" records its arguments.
  const venv = path.join(base, 'nodevenv/aqdi/20/bin');
  fs.mkdirSync(venv, { recursive: true });
  fs.writeFileSync(path.join(venv, 'npm'), `#!/bin/bash\necho "$PWD $*" > "${base}/npm-args"\n[ -z "$NPM_FAIL" ]\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(venv, 'activate'), `export PATH="${venv}:$PATH"\n`);
  return { base, repo, app, activate: path.join(venv, 'activate') };
}

const deploy = (f, extra = {}) => new Promise((resolve) => {
  execFile('bash', ['deploy-script.sh'], { cwd: f.repo, env: { PATH: process.env.PATH, DEPLOYPATH: f.app, NODEVENV_ACTIVATE: f.activate, ...extra }, timeout: 30000 }, (err, stdout, stderr) => {
    resolve({ code: err ? err.code : 0, all: stdout + stderr });
  });
});

test('server deploy: copies the app, keeps .env and uploads, installs, then restarts', { skip: TOOLS }, async () => {
  const f = fakeRepo();
  try {
    const r = await deploy(f);
    assert.equal(r.code, 0, r.all);
    const at = (p) => path.join(f.app, p);
    assert.equal(fs.readFileSync(at('server.js'), 'utf8'), 'new server');
    assert.ok(fs.existsSync(at('routes/a.js')));
    assert.equal(fs.readFileSync(at('.env'), 'utf8'), 'LIVE_ENV=1', '.env is never overwritten');
    assert.equal(fs.readFileSync(at('storage/uploads/live.jpg'), 'utf8'), 'live-photo', 'uploads survive');
    for (const p of ['tests', 'docs', 'README.md', 'node_modules', '.git', '.github', 'backups', 'storage/uploads/p.jpg', 'tmp/old.txt']) {
      assert.ok(!fs.existsSync(at(p)), `${p} is not copied`);
    }
    assert.equal(fs.readFileSync(path.join(f.base, 'npm-args'), 'utf8').trim(), `${f.app} install --omit=dev --no-audit --no-fund`);
    assert.ok(fs.existsSync(at('tmp/restart.txt')));
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('server deploy: a missing Node.js environment stops before copying; a failed install does not restart', { skip: TOOLS }, async () => {
  const f = fakeRepo();
  try {
    const missing = await deploy(f, { NODEVENV_ACTIVATE: path.join(f.base, 'nodevenv/aqdi/SET_ME/bin/activate') });
    assert.equal(missing.code, 1);
    assert.match(missing.all, /AQDI DEPLOY FAILED: Node\.js activate script not found[\s\S]*Set NODE_VERSION at the top of \.cpanel\.yml[\s\S]*Nothing was copied/);
    assert.equal(fs.readFileSync(path.join(f.app, 'server.js'), 'utf8'), 'old server', 'nothing copied');

    const empty = await deploy(f, { DEPLOYPATH: '/aqdi' });
    assert.equal(empty.code, 1);
    assert.match(empty.all, /is HOME set/);

    const failed = await deploy(f, { NPM_FAIL: '1' });
    assert.equal(failed.code, 1);
    assert.match(failed.all, /npm install failed[\s\S]*NOT restarted/);
    assert.ok(!fs.existsSync(path.join(f.app, 'tmp/restart.txt')));
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});
