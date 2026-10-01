'use strict';

const crypto = require('crypto');
const express = require('express');
const db = require('../config/db');
const selfCheck = require('../services/selfCheck');
const { state } = require('../services/runtimeState');
const { riyadhNow } = require('../utils/time');
const cronJobs = require('../services/cron');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();

router.get('/', (req, res) => {
  res.render('pages/home', { title: 'عقدي' });
});

router.get('/health', async (req, res) => {
  const database = await db.ping();
  res.set('Cache-Control', 'no-store');
  res.json({
    status: state.maintenance ? 'maintenance' : 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    database: database ? 'reachable' : 'unreachable',
    riyadhTime: riyadhNow(),
  });
});

function secretMatches(given, expected) {
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

// Full self-check as JSON, for checking a broken deployment without SSH.
// Send the CRON_SECRET value in the X-Cron-Secret header.
router.get('/health/detail', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const expected = process.env.CRON_SECRET;
    if (!expected || !secretMatches(req.get('x-cron-secret'), expected)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const live = await selfCheck.run({ ensure: false });
    return res.json({
      serving: state.maintenance ? 'maintenance' : 'normal',
      // Compare with your real IP: if this shows 127.0.0.1 for every visitor,
      // the web server is not forwarding client addresses.
      request: { yourIp: req.ip, forwardedHops: (req.get('x-forwarded-for') || '').split(',').filter(Boolean).length },
      startup: state.report,
      live,
    });
  } catch (err) {
    return next(err);
  }
});

// cPanel Cron Jobs fallback: curl -X POST -H "X-Cron-Secret: ..." <APP_URL>/cron/run/<job>.
// Answers only { ok, processed }.
const cronLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyFor: (req) => `cron:${req.ip}`,
  onLimit: (req, res) => res.status(429).json({ ok: false, processed: 0 }),
});

router.post('/cron/run/:job', cronLimit, async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const expected = process.env.CRON_SECRET;
    if (!expected || !secretMatches(req.get('x-cron-secret'), expected)) {
      return res.status(403).json({ ok: false, processed: 0 });
    }
    const job = String(req.params.job || '');
    if (!Object.hasOwn(cronJobs.JOBS, job)) return res.status(404).json({ ok: false, processed: 0 });
    const result = await cronJobs.runJob(job);
    const status = result.error === 'not_implemented' ? 501 : result.ok ? 200 : 500;
    return res.status(status).json({ ok: Boolean(result.ok), processed: Number(result.processed) || 0 });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
