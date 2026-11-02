'use strict';

// Custom domain requests (Prompt 23). An office asks for "my own domain" or
// "reserve a domain for me"; the platform admin handles it by hand and moves
// the status. Nothing here buys a domain, changes DNS, issues SSL or changes
// routing: activation only stores the domain on the office. A later automatic
// connection (Cloudflare on a VPS, docs/DOMAINS.md) plugs into the same
// statuses and the assigned_ns_* / dns_zone_ref fields.
//
// Office side: every query goes through scopeToOffice. Admin side reads across
// offices by design (the platform admin's queue).

const dns = require('node:dns');
const net = require('node:net');
const { domainToASCII } = require('node:url');
const { scopeToOffice } = require('./scopeToOffice');
const { withTransaction } = require('./transaction');
const { planJoin } = require('./defaultPlan');
const { createAudit } = require('./audit');
const { createNotification } = require('./notifications');
const officialPricing = require('./officialPricing');
const money = require('./money');

const STATUSES = Object.freeze(['pending_setup', 'pending_purchase', 'awaiting_nameservers', 'awaiting_dns', 'active', 'rejected', 'cancelled']);
const OPEN = Object.freeze(['pending_setup', 'pending_purchase', 'awaiting_nameservers', 'awaiting_dns']);

const STATUS_LABELS = Object.freeze({
  pending_setup: 'بانتظار الإعداد',
  pending_purchase: 'بانتظار شراء الدومين',
  awaiting_nameservers: 'بانتظار تغيير Nameservers',
  awaiting_dns: 'بانتظار ضبط سجلات DNS',
  active: 'فعّال',
  rejected: 'مرفوض',
  cancelled: 'ملغى',
});

// What the platform admin may move a request to. active, rejected and
// cancelled are final in this version.
const TRANSITIONS = Object.freeze({
  pending_purchase: ['pending_setup', 'awaiting_nameservers', 'awaiting_dns', 'active', 'rejected'],
  pending_setup: ['awaiting_nameservers', 'awaiting_dns', 'active', 'rejected'],
  awaiting_nameservers: ['pending_setup', 'awaiting_dns', 'active', 'rejected'],
  awaiting_dns: ['pending_setup', 'awaiting_nameservers', 'active', 'rejected'],
  active: [],
  rejected: [],
  cancelled: [],
});

const MODES = Object.freeze(['none', 'addon', 'included']);
const SERVICE_FEE_HALALAS = 4000;
const MAX_ALTERNATIVES = 2;
const STALE_DAYS = 3;

// Names that are never a public domain.
const RESERVED_TLDS = new Set(['localhost', 'local', 'test', 'example', 'invalid', 'internal', 'lan', 'home', 'corp', 'localdomain', 'arpa', 'onion']);

const ERRORS = Object.freeze({
  required: 'اكتب اسم الدومين، مثل: myoffice.sa',
  shape: 'اكتب اسم الدومين فقط بدون https:// أو / ، مثل: myoffice.sa',
  invalid: 'اسم الدومين غير صحيح. استخدم حروفاً إنجليزية أو عربية وأرقاماً وشرطة، مع امتداد مثل .sa أو .com',
  ip: 'اكتب اسم دومين وليس عنوان IP.',
  wildcard: 'لا يمكن استخدام النجمة (*) في اسم الدومين.',
  reserved: 'هذا الاسم لا يصلح دوميناً عاماً على الإنترنت.',
  platform: 'لا يمكن استخدام دومين المنصة أو أحد فروعه.',
  taken: 'هذا الدومين مربوط بمكتب آخر.',
  duplicate: 'البدائل يجب أن تختلف عن الاسم الأول وعن بعضها.',
});

/** The platform's host (from APP_URL), lower-case, or ''. */
function platformHost(env = process.env) {
  try {
    return new URL(env.APP_URL || '').hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Pure: checks a domain typed by a person. Returns { ok: true, domain } with the
 * lower-case ASCII (punycode) form, or { ok: false, error } with an Arabic message.
 */
function validateDomain(input, { platform = platformHost() } = {}) {
  let text = String(input ?? '').trim().toLowerCase();
  if (!text) return { ok: false, error: ERRORS.required };
  if (text.endsWith('.')) text = text.slice(0, -1);
  if (/[/:?#@\s\\]/.test(text)) return { ok: false, error: /^\d|\[/.test(text) && net.isIP(text.replace(/^\[|\]$/g, '')) ? ERRORS.ip : ERRORS.shape };
  if (text.includes('*')) return { ok: false, error: ERRORS.wildcard };
  if (net.isIP(text)) return { ok: false, error: ERRORS.ip };
  const ascii = domainToASCII(text);
  if (!ascii || ascii.length > 253) return { ok: false, error: ERRORS.invalid };
  const labels = ascii.split('.');
  if (labels.length < 2) return { ok: false, error: RESERVED_TLDS.has(ascii) ? ERRORS.reserved : ERRORS.invalid };
  for (const label of labels) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return { ok: false, error: ERRORS.invalid };
  }
  const tld = labels[labels.length - 1];
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(tld)) return { ok: false, error: /^\d+$/.test(tld) ? ERRORS.ip : ERRORS.invalid };
  if (RESERVED_TLDS.has(tld) || labels.includes('localhost')) return { ok: false, error: ERRORS.reserved };
  if (platform && (ascii === platform || ascii.endsWith(`.${platform}`) || platform.endsWith(`.${ascii}`))) {
    return { ok: false, error: ERRORS.platform };
  }
  return { ok: true, domain: ascii };
}

/** Pure: a nameserver host typed by the admin (same rules, no platform check), or null. Empty = ''. */
function cleanNameserver(input) {
  const text = String(input ?? '').trim();
  if (!text) return '';
  const checked = validateDomain(text, { platform: '' });
  return checked.ok ? checked.domain : null;
}

/** The CNAME target and A address offices point at with "records" (empty = not configured). */
function recordsConfig(env = process.env) {
  const target = validateDomain(env.APP_DOMAIN_TARGET || '', { platform: '' });
  const ip = String(env.APP_DOMAIN_IP || '').trim();
  return { target: target.ok ? target.domain : '', ip: net.isIPv4(ip) ? ip : '' };
}

/** The office plan's custom_domain mode (none | addon | included). */
async function planMode(pool, officeId) {
  const [[row]] = await pool.query(`SELECT p.custom_domain AS mode FROM offices o ${planJoin()} WHERE o.id = ?`, [officeId]);
  return row && MODES.includes(row.mode) ? row.mode : 'none';
}

/** The add-on as stored (price in halalas), whether it applies to this plan code. */
async function addonFor(pool, planCode) {
  const addon = await officialPricing.customDomainAddon(pool);
  const halalas = money.parseAmount(String(addon.price_monthly ?? ''));
  return { halalas, appliesToPlan: Array.isArray(addon.plans) && addon.plans.includes(planCode) };
}

function parseAlternatives(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }
  return [];
}

function present(row) {
  if (!row) return null;
  return {
    ...row,
    alt_domains: parseAlternatives(row.alt_domains),
    statusLabel: STATUS_LABELS[row.status],
    open: OPEN.includes(row.status),
  };
}

// ------------------------------------------------------------ office side (scoped)

/** Everything the office settings section needs. */
async function officeView(pool, officeId, env = process.env) {
  const scoped = scopeToOffice(pool, officeId);
  const [[office]] = await pool.query(`SELECT o.custom_domain, o.public_slug, p.code AS plan_code FROM offices o ${planJoin()} WHERE o.id = ?`, [officeId]);
  const mode = await planMode(pool, officeId);
  const latest = await scoped.select('office_domain_requests', {}, { orderBy: 'id DESC', limit: 1 });
  const addon = await addonFor(pool, office && office.plan_code);
  return {
    mode,
    addonHalalas: mode === 'addon' ? addon.halalas : null,
    activeDomain: office ? office.custom_domain : null,
    slug: office ? office.public_slug : null,
    request: present(latest[0] || null),
    records: recordsConfig(env),
    serviceFeeHalalas: SERVICE_FEE_HALALAS,
  };
}

/**
 * Creates a request in ONE transaction: the office row is locked first, so two
 * parallel submits cannot both pass the one-open-request rule. Returns
 * { ok: true, id } or { ok: false, errors } (Arabic, by field; `form` for the whole form).
 */
async function createRequest(pool, { officeId, userId, body = {}, ip = null, env = process.env }) {
  const type = body.type === 'reserve' ? 'reserve' : body.type === 'own' ? 'own' : null;
  if (!type) return { ok: false, errors: { form: 'اختر «لدي دومين» أو «احجز لي دوميناً».' } };
  const platform = platformHost(env);
  const errors = {};
  const main = validateDomain(body.domain, { platform });
  if (!main.ok) errors.domain = main.error;
  const alternatives = [];
  if (type === 'reserve') {
    for (let i = 1; i <= MAX_ALTERNATIVES; i += 1) {
      const raw = String(body[`alt_${i}`] ?? '').trim();
      if (!raw) continue;
      const alt = validateDomain(raw, { platform });
      if (!alt.ok) errors[`alt_${i}`] = alt.error;
      else if (alt.domain === main.domain || alternatives.includes(alt.domain)) errors[`alt_${i}`] = ERRORS.duplicate;
      else alternatives.push(alt.domain);
    }
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  const method = type === 'own' && body.connection_method === 'records' ? 'records' : 'nameservers';

  return withTransaction(pool, async (conn) => {
    // Lock only this office's row (a FOR UPDATE on the join would also lock the shared plan row).
    const [[lockedOffice]] = await conn.query('SELECT id, custom_domain FROM offices WHERE id = ? FOR UPDATE', [officeId]);
    if (!lockedOffice) return { ok: false, errors: { form: 'المكتب غير موجود.' } };
    const [[plan]] = await conn.query(`SELECT p.code AS plan_code, p.custom_domain AS mode FROM offices o ${planJoin()} WHERE o.id = ?`, [officeId]);
    const office = { ...lockedOffice, ...(plan || {}) };
    const mode = MODES.includes(office.mode) ? office.mode : 'none';
    if (mode === 'none') return { ok: false, errors: { form: 'باقتك لا تشمل نطاقاً مخصصاً. رقِّ باقتك لتفعيله.' } };
    if (office.custom_domain) return { ok: false, errors: { form: 'لمكتبك نطاق فعّال. لتغييره تواصل مع الدعم.' } };
    const scoped = scopeToOffice(conn, officeId);
    const [open] = await scoped.query(
      `SELECT COUNT(*) AS n FROM office_domain_requests WHERE office_id = :office_id AND status IN (${OPEN.map(() => '?').join(', ')})`,
      OPEN,
    );
    if (Number(open.n) > 0) return { ok: false, errors: { form: 'لديك طلب نطاق مفتوح. ألغه أولاً إذا أردت طلباً جديداً.' } };
    const [[taken]] = await conn.query('SELECT COUNT(*) AS n FROM offices WHERE custom_domain = ? AND id <> ?', [main.domain, officeId]);
    if (Number(taken.n) > 0) return { ok: false, errors: { domain: ERRORS.taken } };
    const addon = mode === 'addon' ? await addonFor(conn, office.plan_code) : { halalas: null };
    const status = type === 'reserve' ? 'pending_purchase' : 'pending_setup';
    const id = await scoped.insert('office_domain_requests', {
      type,
      connection_method: method,
      domain: main.domain,
      alt_domains: type === 'reserve' ? JSON.stringify(alternatives) : null,
      status,
      plan_mode: mode,
      addon_monthly_halalas: addon.halalas,
      service_fee_halalas: SERVICE_FEE_HALALAS,
    });
    await createAudit(conn).write(userId, officeId, 'domain.request', 'domain_request', id, null,
      { type, connection_method: method, domain: main.domain, alternatives: alternatives.length, plan_mode: mode, addon_monthly_halalas: addon.halalas, status }, ip);
    return { ok: true, id };
  });
}

/** Cancels the office's own open request. Returns true when one was cancelled. */
async function cancelRequest(pool, { officeId, userId, requestId, ip = null }) {
  if (!/^\d+$/.test(String(requestId))) return false;
  const scoped = scopeToOffice(pool, officeId);
  const row = await scoped.selectOne('office_domain_requests', { id: Number(requestId) });
  if (!row || !OPEN.includes(row.status)) return false;
  const result = await scoped.query(
    `UPDATE office_domain_requests SET status = 'cancelled' WHERE id = ? AND office_id = :office_id AND status IN (${OPEN.map(() => '?').join(', ')})`,
    [Number(requestId), ...OPEN],
  );
  if (!result || result.affectedRows !== 1) return false;
  await createAudit(pool).log(userId, officeId, 'domain.cancel', 'domain_request', row.id, { status: row.status }, { status: 'cancelled' }, ip);
  return true;
}

// ------------------------------------------------------------ platform admin (across offices)

const PAGE_SIZE = 20;

async function listRequests(pool, { status = '', page = 1 } = {}) {
  const where = STATUSES.includes(status) ? 'WHERE r.status = ?' : status === 'open' ? `WHERE r.status IN (${OPEN.map(() => '?').join(', ')})` : '';
  const params = STATUSES.includes(status) ? [status] : status === 'open' ? [...OPEN] : [];
  const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM office_domain_requests r ${where}`, params);
  const pages = Math.max(1, Math.ceil(Number(n) / PAGE_SIZE));
  const current = Math.min(Math.max(1, Number.parseInt(page, 10) || 1), pages);
  const [rows] = await pool.query(
    `SELECT r.id, r.office_id, r.type, r.connection_method, r.domain, r.status, r.created_at, r.updated_at, r.activated_at, o.name AS office_name
       FROM office_domain_requests r JOIN offices o ON o.id = r.office_id ${where}
      ORDER BY FIELD(r.status, ${OPEN.map(() => '?').join(', ')}) DESC, r.updated_at ASC, r.id DESC
      LIMIT ${PAGE_SIZE} OFFSET ${(current - 1) * PAGE_SIZE}`,
    [...params, ...[...OPEN].reverse()],
  );
  return { rows: rows.map(present), total: Number(n), page: current, pages };
}

async function getRequest(pool, id) {
  if (!/^\d+$/.test(String(id))) return null;
  const [[row]] = await pool.query(
    `SELECT r.*, o.name AS office_name, o.owner_id, o.custom_domain AS office_domain, o.public_slug, p.name_ar AS plan_name, p.custom_domain AS current_plan_mode
       FROM office_domain_requests r JOIN offices o ON o.id = r.office_id ${planJoin()} WHERE r.id = ?`,
    [id],
  );
  return present(row || null);
}

/** Pure: checks the admin form. Returns { values, errors }. */
function validateAdminUpdate(body = {}, current) {
  const errors = {};
  const values = {};
  const status = String(body.status || current.status);
  if (status !== current.status) {
    if (!(TRANSITIONS[current.status] || []).includes(status)) errors.status = 'لا يمكن نقل الطلب إلى هذه الحالة.';
    else values.status = status;
  }
  for (const k of ['assigned_ns_1', 'assigned_ns_2']) {
    if (!(k in body)) continue;
    const ns = cleanNameserver(body[k]);
    if (ns === null) errors[k] = 'اكتب اسم خادم صحيحاً، مثل: ns1.example.com';
    else values[k] = ns || null;
  }
  if ('dns_zone_ref' in body) {
    const ref = String(body.dns_zone_ref ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (ref.length > 255) errors.dns_zone_ref = 'المرجع طويل جداً (255 حرفاً على الأكثر).';
    else values.dns_zone_ref = ref || null;
  }
  if ('admin_note' in body) {
    const note = String(body.admin_note ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
    if (note.length > 500) errors.admin_note = 'الملاحظة طويلة جداً (500 حرف على الأكثر).';
    else values.admin_note = note || null;
  }
  if ('price_cost' in body) {
    const raw = String(body.price_cost ?? '').trim();
    if (!raw) values.price_cost_halalas = null;
    else {
      const h = money.parseAmount(raw);
      if (h === null) errors.price_cost = 'اكتب التكلفة بالريال، مثل 65 أو 65.50';
      else values.price_cost_halalas = h;
    }
  }
  return { values, errors };
}

const NOTIFY_TEXT = {
  pending_setup: 'نعمل على إعداد نطاق مكتبك.',
  pending_purchase: 'وصلنا طلب حجز الدومين ونتحقق من توفره.',
  awaiting_nameservers: 'غيّر Nameservers الدومين عند مزودك إلى القيم الظاهرة في إعدادات مكتبك.',
  awaiting_dns: 'أضف سجلات DNS الظاهرة في إعدادات مكتبك عند مزود الدومين.',
  active: 'أصبح نطاق مكتبك فعّالاً في سجلاتنا. ربط الموقع بالنطاق يتم يدوياً وسنبلغك عند اكتماله.',
  rejected: 'تعذّر تنفيذ طلب النطاق. تواصل مع الدعم لمعرفة التفاصيل.',
};

/**
 * Applies the admin's changes. Activation stores the domain on the office
 * (unique) in the same transaction; routing is NOT changed. Every change is
 * audited with the reason; a status change notifies the office owner.
 * Returns { ok: true, changed } or { ok: false, errors }.
 */
async function adminUpdate(pool, { id, adminId, body, reason, ip = null, now = new Date() }) {
  const current = await getRequest(pool, id);
  if (!current) return { ok: false, notFound: true };
  const { values, errors } = validateAdminUpdate(body, current);
  if (Object.keys(errors).length) return { ok: false, errors };
  const changed = Object.keys(values).filter((k) => String(values[k] ?? '') !== String(current[k] ?? ''));
  if (!changed.length) return { ok: true, changed: [] };

  const outcome = await withTransaction(pool, async (conn) => {
    const [[locked]] = await conn.query('SELECT status FROM office_domain_requests WHERE id = ? FOR UPDATE', [current.id]);
    if (!locked || locked.status !== current.status) return { ok: false, errors: { status: 'تغيّرت حالة الطلب للتو. حدّث الصفحة.' } };
    const updates = Object.fromEntries(changed.map((k) => [k, values[k]]));
    if (updates.status === 'active') {
      try {
        await conn.query('UPDATE offices SET custom_domain = ? WHERE id = ?', [current.domain, current.office_id]);
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return { ok: false, errors: { status: ERRORS.taken } };
        throw err;
      }
      updates.activated_at = now;
    }
    const cols = Object.keys(updates);
    await conn.query(`UPDATE office_domain_requests SET ${cols.map((c) => `\`${c}\` = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => updates[c]), current.id]);
    const after = { reason, changed };
    if (updates.status) after.status = updates.status;
    if ('price_cost_halalas' in updates) after.price_cost_halalas = updates.price_cost_halalas;
    await createAudit(conn).write(adminId, current.office_id, 'admin.domain.update', 'domain_request', current.id,
      updates.status ? { status: current.status } : null, after, ip);
    return { ok: true, changed };
  });
  if (outcome.ok && values.status && current.owner_id) {
    await createNotification(pool, {
      userId: current.owner_id,
      officeId: current.office_id,
      kind: 'domain_update',
      title: `طلب نطاق المكتب: ${STATUS_LABELS[values.status]}`,
      body: `${NOTIFY_TEXT[values.status] || ''}\nالدومين: ${current.domain}`,
      link: '/office/settings#domain',
      now,
    });
  }
  return outcome;
}

// ------------------------------------------------------------ propagation check

/**
 * A standard NS lookup (node:dns, no new dependency). Returns { ok, ns,
 * expected, matches } or { ok: false, error } with a short code. `resolver`
 * is replaceable in tests: { resolveNs(domain) -> Promise<string[]> }.
 */
let resolverOverride = null;
/** For tests: a stub { resolveNs(domain) } used instead of the real resolver; null restores it. */
function setResolver(resolver) {
  resolverOverride = resolver;
}

async function checkNameservers(domain, { expected = [], resolver = null, timeoutMs = 5000 } = {}) {
  const r = resolver || resolverOverride || new dns.promises.Resolver({ timeout: timeoutMs, tries: 2 });
  const want = expected.filter(Boolean).map((s) => String(s).toLowerCase().replace(/\.$/, '')).sort();
  try {
    const found = (await r.resolveNs(domain)).map((s) => String(s).toLowerCase().replace(/\.$/, '')).sort();
    const matches = want.length > 0 ? want.every((ns) => found.includes(ns)) : null;
    return { ok: true, ns: found, expected: want, matches };
  } catch (err) {
    return { ok: false, error: String(err.code || 'lookup_failed').slice(0, 40), expected: want };
  }
}

const LOOKUP_ERRORS = {
  ENOTFOUND: 'الدومين غير موجود في DNS (قد لا يكون مسجلاً بعد).',
  ENODATA: 'لا توجد سجلات NS لهذا الدومين بعد.',
  ETIMEOUT: 'انتهت مهلة الاستعلام. حاول مرة أخرى.',
  ESERVFAIL: 'خادم DNS لم يستطع الإجابة الآن (SERVFAIL).',
  ECONNREFUSED: 'تعذّر الاتصال بخادم DNS.',
};

/** Open requests whose last change is older than STALE_DAYS (launch check). */
async function staleCount(pool, { days = STALE_DAYS } = {}) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS n FROM office_domain_requests
      WHERE status IN (${OPEN.map(() => '?').join(', ')}) AND updated_at < UTC_TIMESTAMP() - INTERVAL ${Number(days)} DAY`,
    OPEN,
  );
  return Number(row.n);
}

module.exports = {
  STATUSES,
  OPEN,
  STATUS_LABELS,
  TRANSITIONS,
  MODES,
  ERRORS,
  LOOKUP_ERRORS,
  SERVICE_FEE_HALALAS,
  STALE_DAYS,
  platformHost,
  validateDomain,
  cleanNameserver,
  recordsConfig,
  planMode,
  officeView,
  createRequest,
  cancelRequest,
  listRequests,
  getRequest,
  validateAdminUpdate,
  adminUpdate,
  checkNameservers,
  setResolver,
  staleCount,
};
