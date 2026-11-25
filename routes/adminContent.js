'use strict';

// Admin pages added with the public site: abuse reports on listings, the
// contact-form messages, the blog and the analytics snippet. Registered on the
// admin router (routes/admin.js), so every route here already runs behind the
// admin guard (platform_admin, 2FA, same-origin, no-store). Like every admin
// change, each action needs a written reason and writes an audit row.

const fileUpload = require('express-fileupload');
const db = require('../config/db');
const blog = require('../services/blog');
const images = require('../services/images');
const platformSettings = require('../services/platformSettings');
const { sanitizeSnippet } = require('../services/analytics');
const { REPORT_REASONS } = require('../services/inquiries');
const { createNotification } = require('../services/notifications');
const { riyadhDate } = require('../services/contractDates');
const email = require('../services/channels/email');

const IMAGE_ERRORS = {
  type: 'غلاف المقال يجب أن يكون صورة JPG أو PNG أو WebP.', size: 'حجم الغلاف أكبر من 5 ميجابايت.', empty: 'ملف الغلاف فارغ.', corrupt: 'تعذّرت قراءة صورة الغلاف.',
};

module.exports = function register(router, { wrap, notFound, reasonOf, REASON_ERROR, audit, doneText }) {
  const upload = fileUpload({
    useTempFiles: false, abortOnLimit: false, limits: { fileSize: images.MAX_BYTES, files: 1, fields: 12, fieldSize: 70000 }, uploadTimeout: 60 * 1000, debug: false,
  });
  const idOf = (raw) => (/^[1-9]\d{0,17}$/.test(String(raw)) ? Number(raw) : null);

  // ------------------------------------------------------------ office reviews (comments wait for approval)

  const reviewsSvc = require('../services/reviews');
  async function renderReviews(req, res, { error = null, status = 200 } = {}) {
    const rows = await reviewsSvc.pendingList(db.pool);
    return res.status(status).render('admin/reviews', { title: 'تقييمات المكاتب', rows, roleLabels: reviewsSvc.ROLE_LABELS, error, done: doneText(req.query.done) });
  }
  router.get('/admin/reviews', wrap((req, res) => renderReviews(req, res)));
  for (const [action, decision] of [['approve', 'approved'], ['reject', 'rejected']]) {
    router.post(`/admin/reviews/:id/${action}`, wrap(async (req, res) => {
      const reason = reasonOf(req.body);
      if (!reason) return renderReviews(req, res, { error: REASON_ERROR, status: 422 });
      const changed = await reviewsSvc.moderate(db.pool, { id: req.params.id, decision, adminId: req.user.id, reason, ip: req.ip });
      if (!changed) return notFound(res);
      return res.redirect(`/admin/reviews?done=${action === 'approve' ? 'review_approved' : 'review_rejected'}`);
    }));
  }

  // ------------------------------------------------------------ listing reports

  async function renderReports(req, res, { error = null, status = 200 } = {}) {
    const [rows] = await db.pool.query(
      `SELECT r.id, r.listing_id, r.reason, r.note, r.status, r.created_at, r.handled_at,
              l.title, l.status AS listing_status, l.admin_hidden, o.id AS office_id, o.name AS office_name, o.listings_banned
         FROM listing_reports r JOIN listings l ON l.id = r.listing_id JOIN offices o ON o.id = l.office_id
        ORDER BY (r.status = 'open') DESC, r.id DESC LIMIT 200`,
    );
    return res.status(status).render('admin/reports', { title: 'بلاغات الإعلانات', rows, reasons: REPORT_REASONS, error, done: doneText(req.query.done) });
  }

  router.get('/admin/reports', wrap((req, res) => renderReports(req, res)));

  async function reportAction(req, res, handler) {
    const id = idOf(req.params.id);
    const [[row]] = id ? await db.pool.query(
      'SELECT r.id, r.listing_id, l.office_id FROM listing_reports r JOIN listings l ON l.id = r.listing_id WHERE r.id = ?', [id],
    ) : [[]];
    if (!row) return notFound(res);
    const reason = reasonOf(req.body);
    if (!reason) return renderReports(req, res, { error: REASON_ERROR, status: 422 });
    return handler({ row, reason });
  }

  router.post('/admin/reports/:id/dismiss', wrap((req, res) => reportAction(req, res, async ({ row, reason }) => {
    await db.pool.query("UPDATE listing_reports SET status = 'dismissed', handled_by = ?, handled_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'open'", [req.user.id, row.id]);
    await audit.write(req.user.id, row.office_id, 'admin.report.dismiss', 'listing_report', Number(row.id), null, { listing_id: Number(row.listing_id), reason }, req.ip);
    return res.redirect('/admin/reports?done=dismissed');
  })));

  router.post('/admin/reports/:id/hide', wrap((req, res) => reportAction(req, res, async ({ row, reason }) => {
    await db.pool.query(
      "UPDATE listings SET admin_hidden = 1, admin_hidden_reason = ?, status = IF(status = 'published', 'hidden', status) WHERE id = ?",
      [reason, row.listing_id],
    );
    await db.pool.query("UPDATE listing_reports SET status = 'actioned', handled_by = ?, handled_at = UTC_TIMESTAMP() WHERE listing_id = ? AND status = 'open'", [req.user.id, row.listing_id]);
    await audit.write(req.user.id, row.office_id, 'admin.listing.hide', 'listing', Number(row.listing_id), null, { admin_hidden: true, reason }, req.ip);
    const [[office]] = await db.pool.query('SELECT name, owner_id FROM offices WHERE id = ?', [row.office_id]);
    if (office && office.owner_id) {
      await createNotification(db.pool, {
        userId: office.owner_id, officeId: row.office_id, kind: 'listing_report', title: 'أُخفي أحد إعلاناتك',
        body: `أخفت إدارة المنصة الإعلان رقم ${row.listing_id}. السبب: ${reason}`, link: `/office/listings/${row.listing_id}`, dedupeKey: `listing_hidden:${row.listing_id}:${Date.now()}`,
      }).catch(() => {});
    }
    return res.redirect('/admin/reports?done=hidden');
  })));

  router.post('/admin/listings/:id/unhide', wrap(async (req, res) => {
    const id = idOf(req.params.id);
    const [[listing]] = id ? await db.pool.query('SELECT id, office_id FROM listings WHERE id = ?', [id]) : [[]];
    if (!listing) return notFound(res);
    const reason = reasonOf(req.body);
    if (!reason) return renderReports(req, res, { error: REASON_ERROR, status: 422 });
    await db.pool.query('UPDATE listings SET admin_hidden = 0, admin_hidden_reason = NULL WHERE id = ?', [id]);
    await audit.write(req.user.id, listing.office_id, 'admin.listing.unhide', 'listing', Number(id), { admin_hidden: true }, { admin_hidden: false, reason }, req.ip);
    return res.redirect('/admin/reports?done=unhidden');
  }));

  router.post('/admin/offices/:id/listings-ban', wrap(async (req, res) => {
    const id = idOf(req.params.id);
    const [[office]] = id ? await db.pool.query('SELECT id, listings_banned FROM offices WHERE id = ?', [id]) : [[]];
    if (!office) return notFound(res);
    const reason = reasonOf(req.body);
    if (!reason) return res.status(422).render('errors/403', { title: 'السبب مطلوب', heading: 'السبب مطلوب', message: REASON_ERROR });
    const ban = req.body.ban === '1';
    await db.pool.query('UPDATE offices SET listings_banned = ? WHERE id = ?', [ban ? 1 : 0, id]);
    if (ban) await db.pool.query("UPDATE listings SET status = 'hidden' WHERE office_id = ? AND status = 'published'", [id]);
    await audit.write(req.user.id, id, ban ? 'admin.office.listings_ban' : 'admin.office.listings_unban', 'office', id, { listings_banned: Boolean(Number(office.listings_banned)) }, { listings_banned: ban, reason }, req.ip);
    return res.redirect(`/admin/offices/${id}?done=${ban ? 'banned' : 'unbanned'}`);
  }));

  // ------------------------------------------------------------ contact messages

  const MESSAGE_COLUMNS = 'SELECT id, name, phone, email, message, handled_at, created_at FROM contact_messages ORDER BY (handled_at IS NULL) DESC, id DESC LIMIT 200';
  const renderMessages = async (res, { done = null, error = null, status = 200, openId = null, draft = '' } = {}) => {
    const [rows] = await db.pool.query(MESSAGE_COLUMNS);
    return res.status(status).render('admin/messages', { title: 'رسائل التواصل', rows, done, error, openId, draft, mailReady: Boolean(email.smtpConfig()) });
  };

  router.get('/admin/messages', wrap(async (req, res) => renderMessages(res, { done: doneText(req.query.done) })));

  router.post('/admin/messages/:id/handled', wrap(async (req, res) => {
    const id = idOf(req.params.id);
    const [[row]] = id ? await db.pool.query('SELECT id FROM contact_messages WHERE id = ?', [id]) : [[]];
    if (!row) return notFound(res);
    const reason = reasonOf(req.body);
    if (!reason) return renderMessages(res, { error: REASON_ERROR, status: 422 });
    await db.pool.query('UPDATE contact_messages SET handled_at = COALESCE(handled_at, UTC_TIMESTAMP()) WHERE id = ?', [id]);
    await audit.write(req.user.id, null, 'admin.message.handled', 'contact_message', id, null, { reason }, req.ip);
    return res.redirect('/admin/messages?done=handled');
  }));

  // Reply by email to a visitor who left an address. The reply text is sent and
  // never stored or audited; the message is marked handled.
  router.post('/admin/messages/:id/reply', wrap(async (req, res) => {
    const id = idOf(req.params.id);
    const [[row]] = id ? await db.pool.query('SELECT id, email FROM contact_messages WHERE id = ?', [id]) : [[]];
    if (!row) return notFound(res);
    const body = String(req.body.body || '').replace(/\r\n/g, '\n').trim().slice(0, 3000);
    if (!row.email) return renderMessages(res, { error: 'هذه الرسالة بلا بريد إلكتروني، فلا يمكن الرد عليها بالبريد.', status: 422 });
    if (body.length < 5) return renderMessages(res, { error: 'اكتب نص الرد (5 أحرف على الأقل).', status: 422, openId: id, draft: body });
    if (!email.smtpConfig()) return renderMessages(res, { error: 'البريد الصادر غير مضبوط على الخادم.', status: 503, openId: id, draft: body });
    const text = `${body}\n\nفريق ميعاد`;
    const sent = await email.send({ to: row.email, subject: 'رد من ميعاد على رسالتك', text });
    if (!sent || !sent.ok) return renderMessages(res, { error: 'تعذّر إرسال الرد الآن. حاول مرة أخرى بعد قليل.', status: 502, openId: id, draft: body });
    await db.pool.query('UPDATE contact_messages SET handled_at = COALESCE(handled_at, UTC_TIMESTAMP()) WHERE id = ?', [id]);
    await audit.write(req.user.id, null, 'admin.message.reply', 'contact_message', id, null, { reason: 'رد بالبريد' }, req.ip);
    return res.redirect('/admin/messages?done=replied');
  }));

  // ------------------------------------------------------------ blog

  const blogValues = (post) => (post ? {
    slug: post.slug, title_ar: post.title, excerpt_ar: post.excerpt, body_ar: post.body, meta_title: post.metaTitle,
    meta_description: post.metaDescription, status: post.status, needs_review: post.needsReview,
  } : { slug: '', title_ar: '', excerpt_ar: '', body_ar: '', meta_title: '', meta_description: '', status: 'draft', needs_review: false });

  router.get('/admin/blog', wrap(async (req, res) => {
    return res.render('admin/blog', { title: 'المدونة', rows: await blog.listAll(db.pool), done: doneText(req.query.done), stamp: (at) => (at ? riyadhDate(new Date(at)) : '—') });
  }));

  const renderBlogForm = (res, { post = null, values, errors = {}, status = 200 }) => res.status(status).render('admin/blog-form', {
    title: post ? `المقال: ${post.title}` : 'مقال جديد', post, values, errors,
  });

  router.get('/admin/blog/new', (req, res) => renderBlogForm(res, { values: blogValues(null) }));

  router.post('/admin/blog', upload, wrap(async (req, res) => {
    const { values, errors } = blog.validatePost(req.body, { creating: true });
    const reason = reasonOf(req.body);
    if (!reason) errors.reason = REASON_ERROR;
    const file = req.files && req.files.cover && !Array.isArray(req.files.cover) ? req.files.cover : null;
    req.files = null;
    let cover = null;
    if (!Object.keys(errors).length && file && file.size > 0) {
      const stored = await blog.storeCover(file);
      if (stored.error) errors.cover = IMAGE_ERRORS[stored.error];
      else cover = stored.name;
    }
    if (Object.keys(errors).length) return renderBlogForm(res, { values: { ...blogValues(null), ...req.body, needs_review: req.body.needs_review === '1' }, errors, status: 422 });
    let id;
    try {
      id = await blog.create(db.pool, values, cover);
      await platformSettings.refreshBanner(db.pool);
    } catch (err) {
      if (cover) await images.deleteImage(cover).catch(() => {});
      if (err.code === 'ER_DUP_ENTRY') return renderBlogForm(res, { values: { ...blogValues(null), ...req.body }, errors: { slug: 'هذا الرابط مستخدم من قبل.' }, status: 422 });
      throw err;
    }
    await audit.write(req.user.id, null, 'admin.blog.create', 'blog_post', id, null, { slug: values.slug, status: values.status, reason }, req.ip);
    return res.redirect('/admin/blog?done=created');
  }));

  router.get('/admin/blog/:id', wrap(async (req, res) => {
    const post = await blog.getById(db.pool, req.params.id);
    if (!post) return notFound(res);
    return renderBlogForm(res, { post, values: blogValues(post) });
  }));

  router.post('/admin/blog/:id', upload, wrap(async (req, res) => {
    const post = await blog.getById(db.pool, req.params.id);
    if (!post) return notFound(res);
    const { values, errors } = blog.validatePost(req.body);
    const reason = reasonOf(req.body);
    if (!reason) errors.reason = REASON_ERROR;
    const file = req.files && req.files.cover && !Array.isArray(req.files.cover) ? req.files.cover : null;
    req.files = null;
    let cover = req.body.remove_cover === '1' ? false : null;
    if (!Object.keys(errors).length && file && file.size > 0) {
      const stored = await blog.storeCover(file);
      if (stored.error) errors.cover = IMAGE_ERRORS[stored.error];
      else cover = stored.name;
    }
    if (Object.keys(errors).length) return renderBlogForm(res, { post, values: { ...blogValues(post), ...req.body, needs_review: req.body.needs_review === '1' }, errors, status: 422 });
    await blog.update(db.pool, post.id, values, cover);
    await platformSettings.refreshBanner(db.pool);
    await audit.write(req.user.id, null, 'admin.blog.update', 'blog_post', post.id, { status: post.status }, { status: values.status, reason }, req.ip);
    return res.redirect('/admin/blog?done=saved');
  }));

  router.post('/admin/blog/:id/delete', wrap(async (req, res) => {
    const post = await blog.getById(db.pool, req.params.id);
    if (!post) return notFound(res);
    const reason = reasonOf(req.body);
    if (!reason) return renderBlogForm(res, { post, values: blogValues(post), errors: { reason: REASON_ERROR }, status: 422 });
    await blog.remove(db.pool, post.id);
    await platformSettings.refreshBanner(db.pool);
    await audit.write(req.user.id, null, 'admin.blog.delete', 'blog_post', post.id, { slug: post.slug }, { reason }, req.ip);
    return res.redirect('/admin/blog?done=deleted');
  }));

  // ------------------------------------------------------------ analytics snippet

  router.post('/admin/settings/analytics', wrap(async (req, res) => {
    const reason = reasonOf(req.body);
    const checked = sanitizeSnippet(req.body.snippet);
    const errors = {};
    if (!reason) errors.reason_analytics = REASON_ERROR;
    if (!checked.ok) errors.snippet = checked.error;
    if (Object.keys(errors).length) {
      return res.status(422).render('admin/settings', {
        title: 'إعدادات المنصة',
        values: await (async () => {
          const seller = await platformSettings.seller();
          const bank = await platformSettings.bank();
          const support = await platformSettings.support();
          return { legal_name: seller.legal_name, vat_number: seller.vat_number, address: seller.address, cr_number: seller.cr_number, bank_name: bank.name, bank_account_name: bank.account_name, bank_iban: bank.iban, support_phone: support.phone, support_email: support.email };
        })(),
        errors,
        switches: await platformSettings.switches(),
        analytics: String(req.body.snippet || '').slice(0, 1000),
        ai: require('../services/aiSettings').view(),
        aiValues: { ai_provider: require('../services/aiSettings').view().provider || 'gemini', ai_model: require('../services/aiSettings').view().model },
        aiProviders: require('../services/aiSettings').PROVIDERS,
        done: null,
      });
    }
    await platformSettings.save(db.pool, { [platformSettings.KEYS.analyticsSnippet]: checked.snippet });
    await audit.write(req.user.id, null, 'admin.settings.analytics', 'settings', null, null, { enabled: Boolean(checked.snippet), reason }, req.ip);
    return res.redirect('/admin/settings?done=analytics');
  }));
};
