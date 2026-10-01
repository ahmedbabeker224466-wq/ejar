'use strict';

// Reads ONLY dates and amounts from an uploaded Ejar contract with the Claude
// API (POST https://api.anthropic.com/v1/messages, built-in https only).
//
// Privacy, enforced here:
// - The file exists only in memory for the length of the request. It is never
//   written to disk, the database, logs or error messages.
// - The model is told to return only the whitelisted keys and to ignore
//   names, ID/iqama numbers, IBANs, phones, addresses and meter numbers.
// - The reply is whitelisted again on the server; a value that looks like a
//   national ID or an IBAN is dropped. The raw reply is never logged.
// - Nothing the model says is trusted: every value is validated, and the
//   deadlines and stage come from services/contractEngine.js.

const sharp = require('sharp');
const engine = require('./contractEngine');
const { normalizeCity, CITIES } = require('../config/saudiCities');
const { UNIT_TYPES } = require('./units');
const logger = require('../utils/logger');

// Tunable for tests; production uses the defaults.
const settings = {
  timeoutMs: 30 * 1000,
  maxBytes: 8 * 1024 * 1024,
  maxImageSide: 2000,
  maxTokens: 1024,
  maxReplyBytes: 1024 * 1024,
};

const DEFAULT_MODEL = 'claude-sonnet-4-5';
const API_HOST = 'api.anthropic.com';
const API_PATH = '/v1/messages';
const API_VERSION = '2023-06-01';

const ALLOWED_KEYS = Object.freeze([
  'start_date', 'end_date', 'annual_rent', 'payment_frequency', 'city', 'property_type', 'ejar_contract_number',
]);

const MESSAGES = {
  not_configured: 'قراءة العقد بالذكاء الاصطناعي غير مفعّلة، أدخل البيانات يدوياً',
  empty: 'لم يصل أي ملف. اختر ملف العقد ثم حاول مرة أخرى.',
  too_large: 'حجم الملف أكبر من 8 ميجابايت. صوّر العقد بدقة أقل أو أرسل ملف PDF أصغر.',
  bad_type: 'نوع الملف غير مدعوم. أرسل ملف PDF أو صورة JPG أو PNG أو WebP.',
  bad_file: 'تعذّر فتح الملف. تأكد أنه ملف سليم ثم حاول مرة أخرى.',
  timeout: 'استغرقت القراءة وقتاً طويلاً. حاول مرة أخرى أو أدخل البيانات يدوياً.',
  api_error: 'تعذّرت قراءة الملف الآن. حاول لاحقاً أو أدخل البيانات يدوياً.',
  bad_output: 'لم نتمكن من استخراج بيانات واضحة من الملف. أدخل البيانات يدوياً.',
  refused: 'لم تتم قراءة هذا الملف. أدخل البيانات يدوياً.',
};

class AiReadError extends Error {
  constructor(code) {
    super(code); // the code only: never file contents or model output
    this.name = 'AiReadError';
    this.code = code;
  }

  get messageAr() {
    return MESSAGES[this.code] || MESSAGES.api_error;
  }
}

/** API key and model from the environment. enabled is false without a key. */
function aiConfig(env = process.env) {
  const apiKey = String(env.CLAUDE_API_KEY || '').trim();
  const model = String(env.CLAUDE_MODEL || '').trim() || DEFAULT_MODEL;
  return { enabled: apiKey.length > 0, apiKey, model };
}

// ------------------------------------------------------------ the file

/** The real file type from its first bytes (never the name or the browser's claim). */
function detectFileType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/**
 * Checks an express-fileupload file object. Returns { ok: true, buffer, mime }
 * or { ok: false, code } with code empty | too_large | bad_type.
 */
function checkUpload(file) {
  if (!file || Array.isArray(file) || !Buffer.isBuffer(file.data) || file.data.length === 0) return { ok: false, code: 'empty' };
  if (file.truncated || file.data.length > settings.maxBytes) return { ok: false, code: 'too_large' };
  const mime = detectFileType(file.data);
  if (!mime) return { ok: false, code: 'bad_type' };
  return { ok: true, buffer: file.data, mime };
}

/** The content block for the API: a PDF document, or an image resized to at most 2000px. */
async function contentBlock(buffer, mime) {
  if (mime === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: mime, data: buffer.toString('base64') } };
  }
  let resized;
  try {
    const format = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' }[mime];
    resized = await sharp(buffer, { failOn: 'error' })
      .rotate()
      .resize({ width: settings.maxImageSide, height: settings.maxImageSide, fit: 'inside', withoutEnlargement: true })
      .toFormat(format)
      .toBuffer();
  } catch {
    throw new AiReadError('bad_file');
  }
  return { type: 'image', source: { type: 'base64', media_type: mime, data: resized.toString('base64') } };
}

// ------------------------------------------------------------ the request

const SYSTEM_PROMPT = [
  'You read Saudi residential and commercial rental contracts issued on the Ejar platform.',
  'Documents may be in Arabic, English or both, and dates may be Hijri or Gregorian.',
  'Extract ONLY these fields and return ONE JSON object with exactly these keys:',
  '{"start_date": string|null, "end_date": string|null, "annual_rent": number|null, "payment_frequency": string|null,',
  ' "city": string|null, "property_type": string|null, "ejar_contract_number": string|null}',
  'Rules:',
  '- start_date and end_date: Gregorian YYYY-MM-DD only. If the contract gives only Hijri dates, convert them to Gregorian.',
  '- annual_rent: the yearly rent in Saudi riyals as a plain number (no currency, no separators). If only a total for',
  '  the whole term is given, convert it to a yearly amount.',
  '- payment_frequency: one of "monthly", "quarterly", "semiannual", "annual".',
  '- city: the city name only (for example "Riyadh"), never a street, district detail or full address.',
  '- property_type: one of "apartment", "villa", "shop", "office", "warehouse", "land", "other".',
  '- ejar_contract_number: the Ejar contract reference number only.',
  '- Use null for anything that is not clearly present. Never guess.',
  '- IGNORE and NEVER return: names of any party, national ID or iqama numbers, IBANs or bank accounts, phone',
  '  numbers, email addresses, addresses, meter or electricity account numbers, signatures.',
  '- Reply with the JSON object only: no prose, no explanation, no code fences.',
].join('\n');

function buildRequestBody(block, model) {
  return {
    model,
    max_tokens: settings.maxTokens,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: [block, { type: 'text', text: 'Extract the fields from this contract. Return the JSON object only.' }],
    }],
  };
}

/**
 * POSTs to the Messages API with Node's https. Resolves { status, body } or
 * rejects with AiReadError('timeout' | 'api_error'). Looks up https.request at
 * call time, so tests can replace it.
 */
function callApi(body, { apiKey, timeoutMs = settings.timeoutMs }) {
  const https = require('https');
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const req = https.request({
      hostname: API_HOST,
      path: API_PATH,
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
        'content-type': 'application/json',
        'content-length': payload.length,
      },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > settings.maxReplyBytes) {
          req.destroy();
          finish(reject, new AiReadError('api_error'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => finish(resolve, { status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => finish(reject, new AiReadError('api_error')));
    });
    // One deadline for connecting, sending and reading the whole reply.
    const timer = setTimeout(() => {
      req.destroy();
      finish(reject, new AiReadError('timeout'));
    }, timeoutMs);
    req.on('error', () => finish(reject, new AiReadError('api_error')));
    req.end(payload);
  });
}

// ------------------------------------------------------------ the reply

/** The first JSON object in the model's text (code fences and stray prose tolerated), or null. */
function extractJson(text) {
  if (typeof text !== 'string') return null;
  const unfenced = text.replace(/```(?:json)?/gi, '').trim();
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const value = JSON.parse(unfenced.slice(start, end + 1));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** True for anything that looks like a Saudi national ID / iqama (10 digits, 1 or 2 first) or an IBAN. */
function looksSensitive(value) {
  if (value === null || value === undefined) return false;
  const compact = String(value).replace(/[\s\-.]/g, '');
  return /(^|\D)[12]\d{9}(\D|$)/.test(compact) || /SA\d{22}/i.test(compact);
}

const CITY_AR = Object.fromEntries(CITIES.map((c) => [c.key, c.ar]));
const FIELD_NAMES_AR = {
  start_date: 'تاريخ البداية',
  end_date: 'تاريخ النهاية',
  annual_rent: 'الإيجار السنوي',
  payment_frequency: 'طريقة الدفع',
  city: 'المدينة',
  property_type: 'نوع العقار',
  ejar_contract_number: 'رقم العقد',
};

function warn(code, message) {
  return { code, severity: 'warn', message_ar: message };
}

/**
 * Whitelists and validates the model's object. Returns { fields, warnings }:
 * fields holds only ALLOWED_KEYS, each a valid value or null. Pure.
 */
function sanitizeFields(raw, today) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const fields = Object.fromEntries(ALLOWED_KEYS.map((k) => [k, null]));
  const warnings = [];
  const unclear = (key) => warnings.push(warn(`${key}_unclear`, `لم نتمكن من قراءة ${FIELD_NAMES_AR[key]} بوضوح. أدخله يدوياً.`));

  for (const key of ALLOWED_KEYS) {
    const value = source[key];
    if (value === null || value === undefined || value === '') continue;
    if (typeof value === 'object') {
      unclear(key);
      continue;
    }
    if (looksSensitive(value)) {
      // Never pass on anything shaped like an ID or IBAN, whatever the field.
      warnings.push(warn(`${key}_dropped`, `تجاهلنا قيمة ${FIELD_NAMES_AR[key]} لأنها تشبه رقم هوية أو حساب بنكي. أدخلها يدوياً.`));
      continue;
    }
    const text = String(value).trim();
    switch (key) {
      case 'start_date':
      case 'end_date':
        if (engine.isValidDate(text)) fields[key] = text;
        else unclear(key);
        break;
      case 'annual_rent': {
        const halalas = engine.toHalalas(typeof value === 'number' ? value : text);
        if (halalas !== null && halalas > 0 && halalas <= 999999999999) {
          fields[key] = `${Math.floor(halalas / 100)}.${String(halalas % 100).padStart(2, '0')}`;
        } else unclear(key);
        break;
      }
      case 'payment_frequency':
        if (Object.hasOwn(engine.FREQUENCIES, text)) fields[key] = text;
        else unclear(key);
        break;
      case 'city': {
        const cityKey = normalizeCity(text);
        if (cityKey) fields[key] = CITY_AR[cityKey];
        else unclear(key);
        break;
      }
      case 'property_type':
        if (Object.hasOwn(UNIT_TYPES, text)) fields[key] = text;
        break;
      case 'ejar_contract_number':
        if (/^[A-Za-z0-9\-/ ]{1,40}$/.test(text)) fields[key] = text;
        else unclear(key);
        break;
      default:
        break;
    }
  }

  if (fields.start_date && fields.end_date && engine.compareDates(fields.end_date, fields.start_date) <= 0) {
    warnings.push(warn('dates_inconsistent', 'تاريخ النهاية المقروء ليس بعد تاريخ البداية. أدخل التاريخين يدوياً.'));
    fields.start_date = null;
    fields.end_date = null;
  }

  // The engine's own plausibility checks on what is left (warnings only:
  // missing values are already reported above).
  if (fields.start_date && fields.end_date) {
    for (const w of engine.sanityWarnings({ ...fields, annual_rent: fields.annual_rent ?? '1000' }, today)) {
      if (w.severity === 'warn') warnings.push(w);
    }
  } else if (fields.annual_rent) {
    for (const w of engine.sanityWarnings({ start_date: today, end_date: engine.dateWindow(today, 365).to, annual_rent: fields.annual_rent }, today)) {
      if (['rent_too_low', 'rent_too_high'].includes(w.code)) warnings.push(w);
    }
  }
  return { fields, warnings };
}

/** Engine preview for the extracted dates (never the model's own deadlines). */
function enginePreview(fields, today) {
  if (!fields.start_date || !fields.end_date) return null;
  const contract = { start_date: fields.start_date, end_date: fields.end_date };
  return {
    stage: engine.classifyContract(contract, today),
    ...engine.describeDeadlines(contract, today),
  };
}

/**
 * Reads a contract. Returns { fields, warnings, preview }. Throws
 * AiReadError with code not_configured | bad_file | timeout | api_error |
 * bad_output | refused; the error never carries file or reply contents.
 */
async function readContract({ buffer, mime, today, env = process.env }) {
  const config = aiConfig(env);
  if (!config.enabled) throw new AiReadError('not_configured');
  if (detectFileType(buffer) !== mime) throw new AiReadError('bad_file');

  const block = await contentBlock(buffer, mime);
  const response = await callApi(buildRequestBody(block, config.model), { apiKey: config.apiKey });
  if (response.status !== 200) {
    logger.error(`AI contract read failed: HTTP ${response.status}`);
    throw new AiReadError('api_error');
  }
  let reply;
  try {
    reply = JSON.parse(response.body);
  } catch {
    throw new AiReadError('bad_output');
  }
  if (reply && reply.stop_reason === 'refusal') throw new AiReadError('refused');
  const text = Array.isArray(reply && reply.content)
    ? reply.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
    : '';
  const parsed = extractJson(text);
  if (!parsed) throw new AiReadError('bad_output');

  const { fields, warnings } = sanitizeFields(parsed, today);
  if (ALLOWED_KEYS.every((k) => fields[k] === null)) throw new AiReadError('bad_output');
  return { fields, warnings, preview: enginePreview(fields, today) };
}

module.exports = {
  settings,
  ALLOWED_KEYS,
  MESSAGES,
  SYSTEM_PROMPT,
  AiReadError,
  aiConfig,
  detectFileType,
  checkUpload,
  contentBlock,
  buildRequestBody,
  callApi,
  extractJson,
  looksSensitive,
  sanitizeFields,
  enginePreview,
  readContract,
};
