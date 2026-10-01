'use strict';

// The reminder engine. computeDueReminders() looks at every running contract
// of every office that still has access and, for each reminder rule, asks the
// engine whether one of its thresholds falls exactly on the day (Riyadh
// calendar). Each hit becomes one notification per person (the office member
// in charge, the landlord, the tenant) with a dedupe key, so running twice,
// or after a restart, never sends twice. A missed run catches up the skipped
// days once, marked "متأخر", at most engine APP.reminderCatchUpDays back.
//
// Text uses nicknames (unit label, office name), dates and amounts only.
// All dates come from services/contractEngine.js.

const engine = require('./contractEngine');
const { addDays } = require('./contractDates');
const { scopeToOffice } = require('./scopeToOffice');
const { officeAccess } = require('./offices');
const { createNotification } = require('./notifications');
const { toWesternDigits } = require('../utils/phone');

// Editable per office (reminder_rules). 'before' kinds count days before
// their anchor date, 'after' kinds days after it.
const RULE_KINDS = {
  decision_60: { label: 'موعد قرار التجديد (60 يوماً قبل النهاية)', direction: 'before', anchor: 'decision', days: [60, 45, 30, 14, 7, 3, 1] },
  rent_change_90: { label: 'موعد طلب تغيير الإيجار (90 يوماً قبل النهاية)', direction: 'before', anchor: 'rent_change', days: [90, 60, 30] },
  payment_due: { label: 'دفعة مستحقة', direction: 'before', anchor: 'due_date', days: [7, 3, 0] },
  payment_late: { label: 'دفعة متأخرة', direction: 'after', anchor: 'due_date', days: [1, 3, 7] },
  contract_ended: { label: 'انتهاء العقد', direction: 'after', anchor: 'end_date', days: [1] },
};
const MAX_DAYS = 10;
const MAX_OFFSET = 365;

const AUDIENCE = {
  decision_60: ['office', 'landlord', 'tenant'],
  rent_change_90: ['office', 'landlord', 'tenant'],
  payment_due: ['office', 'tenant'],
  payment_late: ['office', 'tenant'],
  contract_ended: ['office', 'landlord', 'tenant'],
};

// ------------------------------------------------------------ rules

/** Parses "60, 45, 30" (any digit script). Returns { days } or { error }. */
function parseDays(input, direction) {
  const text = toWesternDigits(String(input ?? '')).replace(/،/g, ',');
  const parts = text.split(/[\s,]+/).filter(Boolean);
  if (!parts.length) return { error: 'اكتب يوماً واحداً على الأقل.' };
  const min = direction === 'after' ? 1 : 0;
  const days = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return { error: 'اكتب أرقاماً فقط مفصولة بفواصل.' };
    const n = Number(part);
    if (n < min || n > MAX_OFFSET) return { error: `كل رقم من ${min} إلى ${MAX_OFFSET}.` };
    if (!days.includes(n)) days.push(n);
  }
  if (days.length > MAX_DAYS) return { error: `${MAX_DAYS} أيام كحد أقصى.` };
  return { days: days.sort((a, b) => b - a) };
}

/** Checks the rules form. Returns { values: { kind: { enabled, days } }, errors }. */
function validateRules(body = {}) {
  const values = {};
  const errors = {};
  for (const [kind, rule] of Object.entries(RULE_KINDS)) {
    const parsed = parseDays(body[`${kind}_days`], rule.direction);
    if (parsed.error) errors[kind] = parsed.error;
    values[kind] = { enabled: body[`${kind}_enabled`] === '1' || body[`${kind}_enabled`] === 'on', days: parsed.days || [] };
  }
  return { values, errors };
}

/** The office's rules, defaults filled in. */
async function rulesFor(scoped) {
  const rows = await scoped.select('reminder_rules', {});
  const rules = Object.fromEntries(Object.entries(RULE_KINDS).map(([kind, r]) => [kind, { enabled: true, days: [...r.days] }]));
  for (const row of rows) {
    if (!rules[row.kind]) continue;
    const days = typeof row.days_before === 'string' ? JSON.parse(row.days_before) : row.days_before;
    rules[row.kind] = { enabled: Boolean(Number(row.enabled)), days: Array.isArray(days) ? days.map(Number) : rules[row.kind].days };
  }
  return rules;
}

async function saveRules(scoped, values, actorId) {
  for (const [kind, rule] of Object.entries(values)) {
    await scoped.query(
      `INSERT INTO reminder_rules (office_id, kind, days_before, enabled, updated_by) VALUES (:office_id, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE days_before = VALUES(days_before), enabled = VALUES(enabled), updated_by = VALUES(updated_by)`,
      [kind, JSON.stringify(rule.days), rule.enabled ? 1 : 0, actorId],
    );
  }
}

// ------------------------------------------------------------ message text

const money = (amount) => `${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ريال`;
// Dates stay left-to-right inside Arabic text (on the site, WhatsApp and Telegram).
const ltr = (date) => `\u2066${date}\u2069`;
const daysText = (n) => (n === 0 ? 'اليوم' : n === 1 ? 'غداً' : `بعد ${n} يوم`);

function linkFor(audience, contractId) {
  if (audience === 'office') return `/office/contracts/${contractId}`;
  if (audience === 'landlord') return `/landlord/contracts/${contractId}`;
  return `/tenant#contract-${contractId}`;
}

/**
 * Title and body for one reminder. Riyadh freeze: no rent-increase wording at
 * all, only the freeze notice (office, landlord) or the reduction-request
 * reminder (tenant).
 */
function messageFor({ kind, audience, n, contract, payment = null, officeName, late = false }) {
  const unit = contract.unit_label || 'وحدة';
  const from = audience === 'office' ? '' : ` (${officeName})`;
  const end = contract.end_date;
  let title;
  let body;
  if (kind === 'decision_60') {
    const deadline = engine.noticeDeadline(end);
    title = n === 0 ? `اليوم آخر موعد لقرار التجديد: ${unit}` : `موعد قرار التجديد ${daysText(n)}: ${unit}`;
    const ask = {
      office: 'تواصل مع المالك والمستأجر لمعرفة قرار التجديد.',
      landlord: 'سجّل قرارك (سيجدد / لن يجدد) من صفحتك قبل الموعد.',
      tenant: 'إذا كنت لا ترغب بالتجديد فأبلغ المكتب قبل الموعد.',
    }[audience];
    body = `عقد ${unit}${from}: آخر موعد لإشعار عدم التجديد ${ltr(deadline)}، ونهاية العقد ${ltr(end)}. ${ask}`;
  } else if (kind === 'rent_change_90') {
    const deadline = engine.rentChangeDeadline(end);
    const policy = engine.rentChangePolicy({ city: contract.city, today: deadline, endDate: end });
    if (audience === 'tenant') {
      title = `موعد طلب تخفيض الإيجار ${daysText(n)}: ${unit}`;
      body = `عقد ${unit}${from}: يمكنك طلب تخفيض الإيجار من صفحتك حتى ${ltr(deadline)}.`;
    } else if (!policy.increaseAllowed) {
      title = `تنبيه تجميد الإيجار: ${unit}`;
      body = `عقد ${unit}${from}: الإيجار مجمّد في الرياض حتى ${ltr(policy.freezeUntil)}، فيبقى كما هو عند التجديد. ينتهي العقد ${ltr(end)}.`;
    } else {
      title = `موعد طلب تغيير الإيجار ${daysText(n)}: ${unit}`;
      body = `عقد ${unit}${from}: آخر موعد لطلب تغيير الإيجار ${ltr(deadline)}، ونهاية العقد ${ltr(end)}.`;
    }
  } else if (kind === 'payment_due') {
    title = n === 0 ? `دفعة مستحقة اليوم: ${unit}` : `دفعة تستحق ${daysText(n)}: ${unit}`;
    body = `عقد ${unit}${from}: دفعة ${money(payment.amount)} تاريخ استحقاقها ${ltr(payment.due_date)}.`;
  } else if (kind === 'payment_late') {
    title = `دفعة متأخرة ${n} يوم: ${unit}`;
    body = `عقد ${unit}${from}: دفعة ${money(payment.amount)} كان استحقاقها ${ltr(payment.due_date)} ولم تُسجَّل مدفوعة بعد.`;
  } else {
    title = `انتهى العقد: ${unit}`;
    body = `عقد ${unit}${from}: انتهت مدة العقد في ${ltr(end)}.`;
  }
  if (late) title = `متأخر: ${title}`;
  return { title, body };
}

/** Before-deadline reminders 0 or 1 day ahead skip quiet hours. */
function isUrgent(kind, n) {
  return RULE_KINDS[kind].direction === 'before' && n <= 1;
}

// ------------------------------------------------------------ who gets it

async function recipientsFor(scoped, office, contracts) {
  const ids = contracts.map((c) => Number(c.id));
  const members = await scoped.query('SELECT user_id FROM office_members WHERE is_active = 1 AND office_id = :office_id');
  const activeMembers = new Set(members.map((m) => Number(m.user_id)));
  const tenants = new Map(ids.map((id) => [id, []]));
  if (ids.length) {
    const rows = await scoped.query(
      `SELECT cm.contract_id, cm.user_id FROM contract_members cm
        WHERE cm.role = 'tenant' AND cm.contract_id IN (?) AND cm.contract_id IN (SELECT id FROM contracts WHERE office_id = :office_id)`,
      [ids],
    );
    for (const r of rows) tenants.get(Number(r.contract_id)).push(Number(r.user_id));
  }
  return (contract, audience) => {
    if (audience === 'office') {
      // The member who created the contract is the one in charge; otherwise the owner.
      const assigned = Number(contract.created_by);
      if (assigned && activeMembers.has(assigned)) return [assigned];
      return office.owner_id ? [Number(office.owner_id)] : [];
    }
    if (audience === 'landlord') {
      return contract.landlord_user_id && Number(contract.landlord_active) ? [Number(contract.landlord_user_id)] : [];
    }
    return tenants.get(Number(contract.id)) || [];
  };
}

// ------------------------------------------------------------ the run

/** Every reminder hit for one contract on one day: [{ kind, n, payment }]. */
function hitsFor(contract, payments, rules, day) {
  const hits = [];
  const stage = engine.classifyContract(contract, day);
  const live = engine.LIVE_STAGES.includes(stage);
  const anchors = {
    decision: engine.noticeDeadline(contract.end_date),
    rent_change: engine.rentChangeDeadline(contract.end_date),
    end_date: contract.end_date,
  };
  for (const kind of ['decision_60', 'rent_change_90', 'contract_ended']) {
    const rule = rules[kind];
    if (!rule.enabled) continue;
    if (kind === 'contract_ended' ? stage !== 'ended' : !live) continue;
    const n = engine.thresholdOn(day, anchors[RULE_KINDS[kind].anchor], rule.days, RULE_KINDS[kind].direction);
    if (n !== null) hits.push({ kind, n });
  }
  if (live) {
    for (const payment of payments) {
      for (const kind of ['payment_due', 'payment_late']) {
        const rule = rules[kind];
        if (!rule.enabled) continue;
        const n = engine.thresholdOn(day, payment.due_date, rule.days, RULE_KINDS[kind].direction);
        if (n !== null) hits.push({ kind, n, payment });
      }
    }
  }
  return hits;
}

function dedupeKey({ kind, contractId, payment, audience, userId, n, day }) {
  return [kind, `c${contractId}${payment ? `p${payment.id}` : ''}`, `${audience}-${userId}`, n, day].join(':');
}

async function officeReminders(pool, office, days, now) {
  const scoped = scopeToOffice(pool, office.id);
  const rules = await rulesFor(scoped);
  const oldest = days.reduce((min, d) => (engine.compareDates(d.day, min) < 0 ? d.day : min), days[0].day);
  const contracts = await scoped.query(
    `SELECT c.id, c.landlord_id, c.start_date, c.end_date, c.annual_rent, c.currency, c.city, c.status, c.auto_renew, c.created_by,
            u.label AS unit_label, l.user_id AS landlord_user_id, l.is_active AS landlord_active
       FROM contracts c
       LEFT JOIN units u ON u.id = c.unit_id AND u.office_id = :office_id
       LEFT JOIN landlords l ON l.id = c.landlord_id AND l.office_id = :office_id
      WHERE c.office_id = :office_id AND c.status NOT IN ('terminated','renewed') AND c.end_date >= ?`,
    [addDays(oldest, -(Math.max(...rules.contract_ended.days, 0) + 1))],
  );
  if (!contracts.length) return { created: 0, duplicates: 0 };
  const ids = contracts.map((c) => Number(c.id));
  const payments = await scoped.query(
    `SELECT id, contract_id, due_date, amount, currency, status FROM contract_payments
      WHERE office_id = :office_id AND status IN ('due','late') AND contract_id IN (?)`,
    [ids],
  );
  const byContract = new Map(ids.map((id) => [id, []]));
  for (const p of payments) byContract.get(Number(p.contract_id)).push(p);
  const recipients = await recipientsFor(scoped, office, contracts);

  const counts = { created: 0, duplicates: 0 };
  for (const contract of contracts) {
    for (const { day, late } of days) {
      for (const hit of hitsFor(contract, byContract.get(Number(contract.id)), rules, day)) {
        for (const audience of AUDIENCE[hit.kind]) {
          for (const userId of recipients(contract, audience)) {
            const { title, body } = messageFor({ ...hit, audience, contract, officeName: office.name, late });
            const id = await createNotification(pool, {
              userId,
              officeId: office.id,
              kind: hit.kind,
              title,
              body,
              link: linkFor(audience, contract.id),
              contractId: contract.id,
              dedupeKey: dedupeKey({ ...hit, contractId: contract.id, audience, userId, day }),
              urgent: !late && isUrgent(hit.kind, hit.n),
              now,
            });
            if (id) counts.created += 1;
            else counts.duplicates += 1;
          }
        }
      }
    }
  }
  return counts;
}

/**
 * The daily reminder run. today = riyadhDate(now); lastRun = the last day a
 * run finished (null on the first run). Offices without access (suspended,
 * expired trial) get nothing. Returns { created, duplicates, offices }.
 */
async function computeDueReminders({ pool, today, lastRun = null, now = new Date(), officeId = null }) {
  const days = engine.reminderDays(today, lastRun);
  const [offices] = await pool.query(
    `SELECT id, name, status, trial_ends_at, owner_id FROM offices ${officeId ? 'WHERE id = ?' : ''} ORDER BY id`,
    officeId ? [officeId] : [],
  );
  const total = { created: 0, duplicates: 0, offices: 0 };
  for (const office of offices) {
    if (officeAccess(office, now).locked) continue;
    const counts = await officeReminders(pool, office, days, now);
    total.created += counts.created;
    total.duplicates += counts.duplicates;
    total.offices += 1;
  }
  return total;
}

module.exports = {
  RULE_KINDS,
  AUDIENCE,
  parseDays,
  validateRules,
  rulesFor,
  saveRules,
  messageFor,
  hitsFor,
  dedupeKey,
  isUrgent,
  computeDueReminders,
};
