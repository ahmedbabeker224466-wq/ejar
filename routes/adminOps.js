'use strict';

// /admin/ops: health snapshot, the encrypted backups and "run a backup now",
// the SMS balance and the monthly reports. Registered by routes/admin.js, behind
// the admin guard (platform admin + 2FA + same-origin). Backups are never offered
// for download here: they are fetched from the server's file manager (see DEPLOY.md).

const db = require('../config/db');
const backup = require('../services/backup');
const ops = require('../services/ops');
const cron = require('../services/cron');
const { rateLimit } = require('../middleware/rateLimit');
const { riyadhDate } = require('../services/contractDates');

const RUN_LIMIT = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  keyFor: (req) => `backup-run:${req.user.id}`,
  onLimit: (req, res) => res.status(429).type('text/plain; charset=utf-8').send('يمكنك تشغيل النسخ الاحتياطي يدوياً 3 مرات فقط في الساعة.'),
});

function sizeText(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} ك.ب`;
  return `${(n / (1024 * 1024)).toFixed(1)} م.ب`;
}

function ageText(at, now = new Date()) {
  if (!at) return '—';
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(at).getTime()) / 60000));
  if (minutes < 60) return `قبل ${minutes} دقيقة`;
  if (minutes < 48 * 60) return `قبل ${Math.floor(minutes / 60)} ساعة`;
  return `قبل ${Math.floor(minutes / 1440)} يوماً`;
}

module.exports = function registerOps(router, { wrap, reasonOf, REASON_ERROR, audit, doneText }) {
  async function render(req, res, { error = null, status = 200 } = {}) {
    const [rows, snapshot, sms, reports] = await Promise.all([
      backup.listBackups(db.pool, 30),
      ops.latestSnapshot(db.pool),
      ops.latestSmsBalance(db.pool),
      ops.listReports(db.pool, 12),
    ]);
    return res.status(status).render('admin/ops', {
      title: 'التشغيل والنسخ الاحتياطي',
      backups: rows,
      snapshot,
      sms,
      reports,
      labels: ops.ISSUE_LABELS,
      sizeText,
      ageText: (at) => ageText(at),
      today: riyadhDate(new Date()),
      done: doneText(req.query.done),
      error,
    });
  }

  router.get('/admin/ops', wrap((req, res) => render(req, res)));

  router.post('/admin/ops/backup', RUN_LIMIT, wrap(async (req, res) => {
    const reason = reasonOf(req.body);
    if (!reason) return render(req, res, { error: REASON_ERROR, status: 422 });
    const result = await cron.runJob('backup', { trigger: 'manual' });
    const outcome = result.skipped === 'locked' ? 'locked' : result.ok ? 'ok' : 'failed';
    await audit.write(req.user.id, null, 'admin.backup.run', 'backup', null, null, { reason, outcome }, req.ip);
    return res.redirect(`/admin/ops?done=backup_${outcome}`);
  }));
};
