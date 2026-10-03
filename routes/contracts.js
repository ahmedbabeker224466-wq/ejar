'use strict';

// /office/contracts: list, manual entry with live preview, detail, edit,
// payments, terminate, renew, delete, tenant invite.
// Mounted inside routes/office.js after requireAuth -> loadOffice -> officeGate,
// so req.office is the signed-in member's office. Ids from the URL are looked
// up only inside req.office; anything else answers 404. "today" is always
// riyadhDate(now), and every date comes from services/contractEngine.js.

const express = require('express');
const db = require('../config/db');
const engine = require('../services/contractEngine');
const contracts = require('../services/contracts');
const contractStatus = require('../services/contractStatus');
const invites = require('../services/invites');
const { scopeToOffice } = require('../services/scopeToOffice');
const { parseId } = require('../services/landlords');
const { SAUDI_CITIES } = require('../config/saudiCities');
const { riyadhDate } = require('../services/contractDates');
const { riyadhNow } = require('../utils/time');
const { maskPhone } = require('../utils/phone');
const { requirePerm, can } = require('../middleware/permissions');
const { rateLimit } = require('../middleware/rateLimit');
const fileUpload = require('express-fileupload');
const features = require('../services/features');
const ai = require('../services/aiContractReader');
const aiUsage = require('../services/aiUsage');
const feedback = require('../services/feedback');
const paymentEntries = require('../services/paymentEntries');
const money = require('../services/money');

const router = express.Router();

const MESSAGES = {
  created: 'تم حفظ العقد وإنشاء جدول الدفعات ورمز دعوة المستأجر.',
  saved: 'تم حفظ التعديلات.',
  payment: 'تم تحديث حالة الدفعة.',
  terminated: 'تم إنهاء العقد.',
  renewed: 'تم إنشاء عقد التجديد.',
  deleted: 'تم حذف العقد.',
  invite_created: 'تم إنشاء رمز دعوة جديد للمستأجر.',
  invite_revoked: 'تم إلغاء رمز الدعوة.',
  recorded: 'تم تسجيل الدفعة.',
  undone: 'تم التراجع عن الدفعة.',
  confirmed: 'تم تأكيد الدفعة وأصبحت مدفوعة.',
  rejected: 'تم رفض بلاغ الدفع وعادت الدفعة مستحقة.',
  request_handled: 'تم تحديث حالة الطلب.',
  unchanged: 'لم يتغير شيء: ربما تم التعامل مع هذا من قبل.',
};
const INVITE_LABELS = { active: 'فعّال', used: 'مستخدم', expired: 'منتهي', revoked: 'ملغى' };
const EVENT_LABELS = {
  contract_created: 'تم إنشاء العقد',
  unit_rent_pending: 'ستصبح الوحدة مؤجرة عند بداية العقد',
  unit_rented: 'أصبحت الوحدة مؤجرة',
  stage_changed: 'تغيّرت مرحلة العقد',
  payment_status: 'تغيّرت حالة دفعة',
  payment_recorded: 'تم تسجيل دفعة',
  payment_undone: 'تم التراجع عن دفعة',
  contract_edited: 'تم تعديل بيانات العقد',
  contract_terminated: 'تم إنهاء العقد',
  contract_renewed: 'تم تجديد العقد',
  renewal_deleted: 'حُذف عقد التجديد وعاد هذا العقد',
  tenant_invite_created: 'تم إنشاء رمز دعوة للمستأجر',
  tenant_invite_revoked: 'تم إلغاء رمز دعوة المستأجر',
  tenant_joined: 'انضم المستأجر بالرمز',
  landlord_decision: 'سجّل المالك قراره',
  tenant_request: 'أرسل المستأجر طلب تخفيض الإيجار',
  request_handled: 'تم الرد على طلب المستأجر',
  payment_reported: 'أبلغ المستأجر بدفع دفعة',
  payment_confirmed: 'تم تأكيد دفعة أبلغ عنها المستأجر',
  payment_rejected: 'تم رفض بلاغ دفع من المستأجر',
};

const today = () => riyadhDate(new Date());

function notFound(res) {
  return res.status(404).render('errors/404', { title: 'الصفحة غير موجودة' });
}

function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

async function loadContract(req, res, next) {
  try {
    req.contract = await contracts.getContract(db.pool, req.office.id, parseId(req.params.id));
    return req.contract ? next() : notFound(res);
  } catch (err) {
    return next(err);
  }
}

function baseUrl(req) {
  return (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}

// ------------------------------------------------------------ list

router.get('/office/contracts', requirePerm('contracts'), wrap(async (req, res) => {
  const now = new Date();
  await contractStatus.maybeRecompute({ pool: db.pool, officeId: req.office.id, now, today: riyadhDate(now) });
  const filters = {
    q: String(req.query.q || '').slice(0, 60),
    stage: req.query.stage === 'action' || engine.STAGES.includes(req.query.stage) ? req.query.stage : '',
    landlordId: parseId(req.query.landlord),
    endsWithin: contracts.ENDS_WITHIN.includes(Number(req.query.ends)) ? Number(req.query.ends) : null,
    sort: ['deadline', 'end', 'created'].includes(req.query.sort) ? req.query.sort : 'deadline',
  };
  const result = await contracts.listContracts(db.pool, req.office.id, { ...filters, page: req.query.page }, today());
  const pageUrl = (page) => {
    const params = new URLSearchParams();
    if (filters.q) params.set('q', filters.q);
    if (filters.stage) params.set('stage', filters.stage);
    if (filters.landlordId) params.set('landlord', String(filters.landlordId));
    if (filters.endsWithin) params.set('ends', String(filters.endsWithin));
    if (filters.sort !== 'deadline') params.set('sort', filters.sort);
    if (page > 1) params.set('page', String(page));
    const text = params.toString();
    return `/office/contracts${text ? `?${text}` : ''}`;
  };
  const landlords = await scopeToOffice(db.pool, req.office.id).query(
    'SELECT id, label FROM landlords WHERE office_id = :office_id ORDER BY label ASC',
  );
  return res.render('office/contracts/index', {
    title: 'العقود',
    ...result,
    filters,
    landlords,
    stageLabels: contracts.STAGE_LABELS,
    endsWithin: contracts.ENDS_WITHIN,
    filtered: Boolean(filters.q || filters.stage || filters.landlordId || filters.endsWithin),
    prevUrl: result.page > 1 ? pageUrl(result.page - 1) : null,
    nextUrl: result.page < result.pages ? pageUrl(result.page + 1) : null,
    message: MESSAGES[req.query.done] || null,
  });
}));

// ------------------------------------------------------------ new contract and preview

const previewLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyFor: (req) => `contract-preview:${req.user.id}`,
  onLimit: (req, res) => res.status(429).json({ error: 'طلبات كثيرة. انتظر دقيقة ثم حاول مرة أخرى.' }),
});

/** Live preview for the form: the real engine, no database at all. */
router.post('/office/contracts/preview', requirePerm('contracts'), previewLimit, (req, res) => {
  res.json(contracts.previewContract(req.body || {}, today()));
});

async function formOptions(req) {
  const scoped = scopeToOffice(db.pool, req.office.id);
  return {
    landlords: await scoped.query(
      'SELECT id, label FROM landlords WHERE office_id = :office_id AND is_active = 1 ORDER BY label ASC, id ASC',
    ),
    units: await scoped.query(
      `SELECT u.id, u.label, u.city, u.landlord_id FROM units u
         JOIN landlords l ON l.id = u.landlord_id AND l.office_id = :office_id AND l.is_active = 1
        WHERE u.office_id = :office_id AND u.status = 'vacant' ORDER BY u.label ASC, u.id ASC`,
    ),
    cities: SAUDI_CITIES,
    frequencies: contracts.FREQUENCY_LABELS,
  };
}

function formValues(body = {}) {
  const pick = (f) => String(body[f] ?? '').slice(0, 120);
  return {
    landlord_id: parseId(body.landlord_id),
    unit_id: parseId(body.unit_id),
    contract_number: pick('contract_number'),
    tenant_label: pick('tenant_label'),
    start_date: pick('start_date'),
    end_date: pick('end_date'),
    annual_rent: pick('annual_rent'),
    payment_frequency: pick('payment_frequency') || 'monthly',
    deposit: pick('deposit'),
    commission: pick('commission'),
    city: pick('city'),
    auto_renew: body.auto_renew === undefined ? engine.RULES.AUTO_RENEW_DEFAULT : ['1', 'on', 'true'].includes(String(body.auto_renew)),
    ack_warnings: ['1', 'on', 'true'].includes(String(body.ack_warnings)),
    source: body.source === 'ai' ? 'ai' : 'manual',
  };
}

async function renderForm(req, res, { values, errors = {}, preview = null, warnings = [], needsAck = false, limit = null, status = 200, aiFields = [] }) {
  return res.status(status).render('office/contracts/form', {
    title: 'إضافة عقد',
    values,
    errors,
    preview,
    warnings,
    needsAck,
    limit,
    aiFields,
    fromAi: values.source === 'ai',
    stageLabels: contracts.STAGE_LABELS,
    ...(await formOptions(req)),
  });
}

router.get('/office/contracts/new', requirePerm('contracts'), wrap(async (req, res) => {
  const values = formValues({ landlord_id: req.query.landlord, unit_id: req.query.unit });
  values.auto_renew = engine.RULES.AUTO_RENEW_DEFAULT;
  return renderForm(req, res, { values });
}));

router.post('/office/contracts', requirePerm('contracts'), wrap(async (req, res) => {
  const day = today();
  const shown = formValues(req.body);
  const { values, errors } = contracts.validateContractFields(req.body);
  const previewed = contracts.previewContract(req.body, day);
  const common = { values: shown, preview: previewed.preview, warnings: previewed.warnings, needsAck: previewed.needsAck };
  if (Object.keys(errors).length) return renderForm(req, res, { ...common, errors, status: 422 });

  const evaluated = contracts.evaluateContract(values, day);
  if (!evaluated.ok) return renderForm(req, res, { ...common, errors: evaluated.errors, status: 422 });
  if (req.body.intent === 'preview') return renderForm(req, res, common);
  if (evaluated.needsAck && !values.acknowledged) {
    return renderForm(req, res, { ...common, errors: { ack_warnings: 'راجع التنبيهات، ثم ضع علامة على "راجعت التنبيهات وأريد المتابعة".' }, status: 422 });
  }

  const result = await contracts.createContract(db.pool, req.office.id, { fields: values, actorId: req.user.id, ip: req.ip, today: day });
  if (result.status === 404) return notFound(res);
  if (result.limit) return renderForm(req, res, { ...common, limit: result.limit, status: 409 });
  if (!result.ok) return renderForm(req, res, { ...common, errors: result.errors || {}, status: result.status || 422 });
  return res.redirect(`/office/contracts/${result.id}?done=created`);
}));

// ------------------------------------------------------------ reading a contract file with AI

// At most 5 reads per office per minute (in memory; the monthly plan
// allowance is counted in the database by services/aiUsage.js).
const aiLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyFor: (req) => `ai-read:${req.office.id}`,
  onLimit: (req, res, next) => renderAiUpload(req, res, { status: 429, error: 'طلبات قراءة كثيرة خلال دقيقة. انتظر قليلاً ثم حاول مرة أخرى.' }).catch(next),
});

// The file stays in memory (useTempFiles: false) and is never stored.
// Over 8 MB busboy stops reading and marks the file as truncated.
const aiUpload = fileUpload({
  useTempFiles: false,
  abortOnLimit: false,
  limits: { fileSize: ai.settings.maxBytes, files: 1, fields: 10, fieldSize: 1024 },
  uploadTimeout: 60 * 1000,
  debug: false,
});

async function renderAiUpload(req, res, { status = 200, error = null } = {}) {
  const config = ai.aiConfig();
  const availability = await features.aiAvailability(db.pool, req.office.id);
  const enabled = config.enabled && availability.available;
  return res.status(status).render('office/contracts/ai-upload', {
    title: 'قراءة العقد من ملف',
    enabled,
    disabledMessage: config.enabled ? availability.message : ai.MESSAGES.not_configured,
    usage: enabled ? await aiUsage.usageFor(db.pool, req.office.id) : null,
    error,
  });
}

router.get('/office/contracts/new/ai', requirePerm('contracts.ai'), wrap((req, res) => renderAiUpload(req, res)));

/** Without CLAUDE_API_KEY the feature is off: answer before reading the upload. */
function aiEnabled(req, res, next) {
  if (!ai.aiConfig().enabled) return renderAiUpload(req, res, { status: 503, error: ai.MESSAGES.not_configured }).catch(next);
  return features.aiAvailability(db.pool, req.office.id).then((availability) => {
    if (availability.available) return next();
    return renderAiUpload(req, res, { status: 403, error: availability.message });
  }).catch(next);
}

router.post('/office/contracts/new/ai', requirePerm('contracts.ai'), aiEnabled, aiLimit, aiUpload, wrap(async (req, res) => {
  const file = req.files && req.files.contract;
  req.files = null; // keep no reference to the upload beyond this handler
  const upload = ai.checkUpload(file);
  if (!upload.ok) return renderAiUpload(req, res, { status: 422, error: ai.MESSAGES[upload.code] });

  const reservation = await aiUsage.reserveRead(db.pool, req.office.id);
  if (!reservation.ok) {
    return renderAiUpload(req, res, {
      status: 429,
      error: `استخدمت كل قراءات الذكاء الاصطناعي في باقتك لهذا الشهر (${reservation.limit}). أدخل البيانات يدوياً أو رقِّ اشتراكك.`,
    });
  }
  const day = today();
  let result;
  try {
    result = await ai.readContract({ buffer: upload.buffer, mime: upload.mime, today: day });
  } catch (err) {
    await aiUsage.releaseRead(db.pool, req.office.id, reservation.month);
    if (err instanceof ai.AiReadError) return renderAiUpload(req, res, { status: 502, error: err.messageAr });
    throw err;
  }

  // The same form as manual entry, filled with what was read. Landlord, unit
  // and tenant nickname are always chosen by the person. Nothing is saved yet.
  const f = result.fields;
  const values = formValues({
    start_date: f.start_date || '',
    end_date: f.end_date || '',
    annual_rent: f.annual_rent || '',
    payment_frequency: f.payment_frequency || 'monthly',
    city: f.city || '',
    contract_number: f.ejar_contract_number || '',
    source: 'ai',
  });
  values.auto_renew = engine.RULES.AUTO_RENEW_DEFAULT;
  const aiFields = [
    ['start_date', f.start_date], ['end_date', f.end_date], ['annual_rent', f.annual_rent],
    ['payment_frequency', f.payment_frequency], ['city', f.city], ['contract_number', f.ejar_contract_number],
  ].filter(([, v]) => v).map(([k]) => k);
  const previewed = contracts.previewContract(values, day);
  const seen = new Set();
  const warnings = [...result.warnings, ...previewed.warnings].filter((w) => !seen.has(w.code) && seen.add(w.code));
  return renderForm(req, res, { values, preview: previewed.preview, warnings, needsAck: previewed.needsAck, aiFields });
}));

// ------------------------------------------------------------ detail

async function inviteView(req, contract) {
  const row = await invites.latestTenantInvite(scopeToOffice(db.pool, req.office.id), contract.id);
  if (!row) return null;
  const status = invites.inviteStatus(row);
  return {
    status,
    label: INVITE_LABELS[status],
    code: status === 'active' ? row.code : null,
    expiresOn: riyadhDate(new Date(row.expires_at)),
    usedBy: status === 'used' && row.used_by_phone ? maskPhone(row.used_by_phone) : null,
    shareLink: status === 'active'
      ? invites.inviteShareLink({ code: row.code, officeName: req.office.name, baseUrl: baseUrl(req), kind: 'tenant' })
      : null,
  };
}

function eventText(event) {
  const label = EVENT_LABELS[event.event_type] || event.event_type;
  const d = event.details || {};
  if (event.event_type === 'stage_changed') return `${label}: ${contracts.STAGE_LABELS[d.to] || d.to}`;
  if (event.event_type === 'payment_status') {
    return `${label} (${d.due_date}) إلى: ${contracts.PAYMENT_LABELS[d.to] || d.to}`;
  }
  if (event.event_type === 'unit_rent_pending') return `${label} (${d.start_date})`;
  if (event.event_type === 'landlord_decision') return `${label}: ${feedback.DECISIONS[d.decision] || ''}`;
  if (event.event_type === 'request_handled') return `${label}: ${feedback.REQUEST_STATUSES[d.status] || ''}`;
  return label;
}

async function feedbackView(req, contract) {
  const view = await feedback.contractFeedback(db.pool, req.office.id, contract);
  const day = (row) => ({ ...row, createdOn: riyadhDate(new Date(row.created_at)) });
  return { ...view, decisions: view.decisions.map(day), requests: view.requests.map(day) };
}

async function renderDetail(req, res, { status = 200, error = null } = {}) {
  const contract = req.contract;
  const day = today();
  const described = engine.describeContract(contract, day);
  const history = await paymentEntries.historyFor(db.pool, req.office.id, contract.id, day);
  const payments = history.map((p) => ({
    ...p,
    paidOn: p.paid_at ? new Date(p.paid_at).toISOString().slice(0, 10) : null,
    reportedOn: p.reported_at ? riyadhDate(new Date(p.reported_at)) : null,
  }));
  const sums = paymentEntries.totalsOf(history);
  const events = await contracts.eventsFor(db.pool, req.office.id, contract.id);
  const running = engine.LIVE_STAGES.includes(contract.status);
  return res.status(status).render('office/contracts/show', {
    title: contract.unit_label ? `عقد ${contract.unit_label}` : 'عقد',
    contract,
    described,
    stage: described.stage,
    stageLabels: contracts.STAGE_LABELS,
    frequencyLabels: contracts.FREQUENCY_LABELS,
    paymentLabels: contracts.PAYMENT_LABELS,
    officePaymentLabels: contracts.OFFICE_PAYMENT_LABELS,
    paymentMethods: contracts.PAYMENT_METHODS,
    feedback: await feedbackView(req, contract),
    decisionLabels: feedback.DECISIONS,
    requestTypes: feedback.REQUEST_TYPES,
    requestStatuses: feedback.REQUEST_STATUSES,
    hijri: { start: engine.formatHijri(contract.start_date), end: engine.formatHijri(contract.end_date) },
    rentPolicy: engine.rentChangePolicy({ city: contract.city, today: day, endDate: contract.end_date }),
    payments,
    totals: { schedule: money.toDecimal(sums.scheduled), paid: money.toDecimal(sums.collected), open: money.toDecimal(sums.remaining) },
    fmt: money.formatHalalas,
    entryMethods: paymentEntries.METHODS,
    entryRoleLabels: paymentEntries.ROLE_LABELS,
    undoable: (e) => can(req.memberRole, 'payments.write') && e.canUndo,
    today: day,
    timeline: events.map((e) => ({ text: eventText(e), at: riyadhNow(new Date(e.created_at)).slice(0, 16) })),
    invite: await inviteView(req, contract),
    message: MESSAGES[req.query.done] || null,
    error,
    running,
    canTerminate: running && can(req.memberRole, 'contracts.terminate'),
    canRenew: !['terminated', 'renewed'].includes(contract.status),
    canDelete: can(req.memberRole, 'contracts.delete') && !['ended', 'renewed'].includes(described.stage)
      && !payments.some((p) => p.status === 'paid'),
    canPay: can(req.memberRole, 'payments.write'),
  });
}

router.get('/office/contracts/:id', requirePerm('contracts'), loadContract, wrap((req, res) => renderDetail(req, res)));

// ------------------------------------------------------------ edit (only the fields that may change)

function editValues(source) {
  return {
    tenant_label: source.tenant_label || '',
    contract_number: source.contract_number || '',
    deposit: source.deposit ?? '',
    commission: source.commission ?? '',
    auto_renew: Number(source.auto_renew) === 1 || source.auto_renew === true,
  };
}

router.get('/office/contracts/:id/edit', requirePerm('contracts'), loadContract, (req, res) => {
  res.render('office/contracts/edit', { title: 'تعديل العقد', contract: req.contract, values: editValues(req.contract), errors: {} });
});

router.post('/office/contracts/:id/edit', requirePerm('contracts'), loadContract, wrap(async (req, res) => {
  const { values, errors } = contracts.validateEditFields(req.body);
  if (Object.keys(errors).length) {
    const shown = { ...editValues(values), deposit: String(req.body.deposit ?? '').slice(0, 30), commission: String(req.body.commission ?? '').slice(0, 30) };
    return res.status(422).render('office/contracts/edit', { title: 'تعديل العقد', contract: req.contract, values: shown, errors });
  }
  await contracts.editContract(db.pool, req.office.id, req.contract.id, { fields: values, actorId: req.user.id, ip: req.ip });
  return res.redirect(`/office/contracts/${req.contract.id}?done=saved`);
}));

// ------------------------------------------------------------ payments

router.post('/office/contracts/:id/payments/:paymentId', requirePerm('payments.write'), loadContract, wrap(async (req, res) => {
  const paymentId = parseId(req.params.paymentId);
  if (!paymentId) return notFound(res);
  const { values, errors } = contracts.validatePaymentChange(req.body, today());
  if (Object.keys(errors).length) return renderDetail(req, res, { status: 422, error: Object.values(errors)[0] });
  const done = await contracts.setPaymentStatus(db.pool, req.office.id, req.contract.id, paymentId, { values, actorId: req.user.id, ip: req.ip });
  if (!done) return notFound(res);
  return res.redirect(`/office/contracts/${req.contract.id}?done=payment#payments`);
}));

// The tenant said "I paid": the office confirms (paid) or rejects (back to due).
for (const action of ['confirm', 'reject']) {
  router.post(`/office/contracts/:id/payments/:paymentId/${action}`, requirePerm('payments.write'), loadContract, wrap(async (req, res) => {
    const paymentId = parseId(req.params.paymentId);
    if (!paymentId) return notFound(res);
    const changed = await feedback.answerReportedPayment(db.pool, req.office.id, {
      contractId: req.contract.id, paymentId, confirm: action === 'confirm', actorId: req.user.id, by: 'office', ip: req.ip,
    });
    const done = changed ? (action === 'confirm' ? 'confirmed' : 'rejected') : 'unchanged';
    return res.redirect(`/office/contracts/${req.contract.id}?done=${done}#payments`);
  }));
}

// ------------------------------------------------------------ tenant requests

router.post('/office/contracts/:id/requests/:requestId', requirePerm('contracts'), loadContract, wrap(async (req, res) => {
  const requestId = parseId(req.params.requestId);
  if (!requestId) return notFound(res);
  const changed = await feedback.handleRequest(db.pool, req.office.id, {
    contractId: req.contract.id, requestId, status: String(req.body.status || ''), actorId: req.user.id, ip: req.ip,
  });
  return res.redirect(`/office/contracts/${req.contract.id}?done=${changed ? 'request_handled' : 'unchanged'}#feedback`);
}));

// ------------------------------------------------------------ terminate

router.get('/office/contracts/:id/terminate', requirePerm('contracts.terminate'), loadContract, (req, res) => {
  res.render('office/contracts/terminate', { title: 'إنهاء العقد', contract: req.contract, values: { reason: '' }, errors: {} });
});

router.post('/office/contracts/:id/terminate', requirePerm('contracts.terminate'), loadContract, wrap(async (req, res) => {
  const reason = String(req.body.reason ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  const errors = {};
  if (reason.length < 3 || reason.length > 255) errors.reason = 'اكتب سبب الإنهاء (من 3 إلى 255 حرفاً).';
  if (!['1', 'on', 'true'].includes(String(req.body.confirm))) errors.confirm = 'ضع علامة للتأكيد.';
  if (Object.keys(errors).length) {
    return res.status(422).render('office/contracts/terminate', { title: 'إنهاء العقد', contract: req.contract, values: { reason: reason.slice(0, 255) }, errors });
  }
  const result = await contracts.terminateContract(db.pool, req.office.id, req.contract.id, { reason, actorId: req.user.id, ip: req.ip, today: today() });
  if (result === 'not_found') return notFound(res);
  if (result === 'not_running') return renderDetail(req, res, { status: 409, error: 'لا يمكن إنهاء عقد منتهٍ أو مُنهى أو مُجدَّد.' });
  return res.redirect(`/office/contracts/${req.contract.id}?done=terminated`);
}));

// ------------------------------------------------------------ renew

function renderRenew(req, res, { values, errors = {}, status = 200 }) {
  const defaults = contracts.renewalDefaults(req.contract, today());
  return res.status(status).render('office/contracts/renew', {
    title: 'تجديد العقد',
    contract: req.contract,
    defaults,
    values,
    errors,
    frequencies: contracts.FREQUENCY_LABELS,
  });
}

router.get('/office/contracts/:id/renew', requirePerm('contracts'), loadContract, (req, res) => {
  if (['terminated', 'renewed'].includes(req.contract.status)) {
    return renderDetail(req, res, { status: 409, error: 'لا يمكن تجديد عقد مُنهى أو سبق تجديده.' });
  }
  return renderRenew(req, res, { values: { annual_rent: req.contract.annual_rent, payment_frequency: req.contract.payment_frequency } });
});

router.post('/office/contracts/:id/renew', requirePerm('contracts'), loadContract, wrap(async (req, res) => {
  const values = { annual_rent: String(req.body.annual_rent ?? '').slice(0, 30), payment_frequency: String(req.body.payment_frequency ?? '') };
  const result = await contracts.renewContract(db.pool, req.office.id, req.contract.id, {
    fields: values, actorId: req.user.id, ip: req.ip, today: today(),
  });
  if (result.ok) return res.redirect(`/office/contracts/${result.id}?done=renewed`);
  if (result.status === 404) return notFound(res);
  if (result.reason === 'closed') return renderDetail(req, res, { status: 409, error: 'لا يمكن تجديد عقد مُنهى أو سبق تجديده.' });
  if (result.reason === 'overlap') return renderRenew(req, res, { values, errors: { form: 'يوجد عقد آخر على الوحدة في فترة التجديد.' }, status: 409 });
  if (result.reason === 'no_unit') return renderRenew(req, res, { values, errors: { form: 'الوحدة غير موجودة.' }, status: 409 });
  if (result.limit) return renderRenew(req, res, { values, errors: { form: result.limit }, status: 409 });
  return renderRenew(req, res, { values, errors: result.errors || {}, status: result.status || 422 });
}));

// ------------------------------------------------------------ delete

router.post('/office/contracts/:id/delete', requirePerm('contracts.delete'), loadContract, wrap(async (req, res) => {
  const result = await contracts.deleteContract(db.pool, req.office.id, req.contract.id, { actorId: req.user.id, ip: req.ip, today: today() });
  if (result === 'not_found') return notFound(res);
  if (result === 'history') return renderDetail(req, res, { status: 409, error: 'لا يمكن حذف عقد منتهٍ أو مُجدَّد: يبقى للسجل.' });
  if (result === 'has_paid') return renderDetail(req, res, { status: 409, error: 'للعقد دفعات مدفوعة، فلا يمكن حذفه. أنهِ العقد بدلاً من حذفه.' });
  return res.redirect('/office/contracts?done=deleted');
}));

// ------------------------------------------------------------ tenant invite

const inviteLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  keyFor: (req) => `tenant-invite:${req.office.id}`,
  onLimit: (req, res, next) => renderDetail(req, res, { status: 429, error: 'أنشأت رموز دعوة كثيرة خلال ساعة. انتظر قليلاً.' }).catch(next),
});

router.post('/office/contracts/:id/invite', requirePerm('contracts'), loadContract, inviteLimit, wrap(async (req, res) => {
  const result = await contracts.createTenantInviteFor(db.pool, req.office.id, req.contract.id, { actorId: req.user.id, ip: req.ip });
  if (!result.ok && result.reason === 'not_found') return notFound(res);
  if (!result.ok) return renderDetail(req, res, { status: 409, error: 'لا يمكن إنشاء رمز دعوة لعقد مُنهى أو مُجدَّد.' });
  return res.redirect(`/office/contracts/${req.contract.id}?done=invite_created#invite`);
}));

router.post('/office/contracts/:id/invite/revoke', requirePerm('contracts'), loadContract, wrap(async (req, res) => {
  await contracts.revokeTenantInviteFor(db.pool, req.office.id, req.contract.id, { actorId: req.user.id, ip: req.ip });
  return res.redirect(`/office/contracts/${req.contract.id}?done=invite_revoked#invite`);
}));

module.exports = router;
