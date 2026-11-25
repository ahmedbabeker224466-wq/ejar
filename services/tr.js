'use strict';

// Translation of the app's own Arabic text (Nov 2026). The Arabic sentence is
// the key, locales/en.json holds its English. Text with changing parts is
// stored as a template whose parts are {0}, {1}, ... (or {name}); a sentence
// built in code is matched against those templates. Anything not in the file
// stays as it is, so a missing entry shows Arabic, never a broken page.
// Pure module apart from reading the JSON file once.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'locales', 'en.json');
const LANGS = Object.freeze(['ar', 'en']);
const ARABIC = /[؀-ۿ]/;
const ARABIC_LETTER = /[\u0621-\u064A]/;

let exact = new Map();
let templates = [];

const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Loads a dictionary { arabic: english } (the file by default). */
function load(dict = null) {
  const data = dict || JSON.parse(fs.readFileSync(FILE, 'utf8'));
  exact = new Map();
  templates = [];
  for (const [ar, en] of Object.entries(data)) {
    if (typeof en !== 'string' || !en) continue;
    const key = norm(ar);
    if (/\{[A-Za-z0-9_]+\}/.test(key)) {
      const names = [];
      const source = escapeRe(key).replace(/\\\{([A-Za-z0-9_]+)\\\}/g, (m, name) => { names.push(name); return '([\\s\\S]+?)'; });
      const fixedText = key.replace(/\{[A-Za-z0-9_]+\}/g, '');
      templates.push({ re: new RegExp(`^${source}$`), names, en, fixed: fixedText.length, words: ARABIC_LETTER.test(fixedText) });
    } else {
      exact.set(key, en);
    }
  }
  // The most specific template (most fixed text) wins.
  templates.sort((a, b) => b.fixed - a.fixed);
}

function fill(text, vars) {
  if (!vars) return text;
  return text.replace(/\{([A-Za-z0-9_]+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])));
}

/**
 * The text in the given language. Arabic (or anything without Arabic letters)
 * comes back as it is, with {vars} filled in. Leading and trailing spaces are
 * kept so wrapped template text keeps its layout.
 */
const DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9', '٫': '.', '٬': ',' };
const latinDigits = (s) => s.replace(/[٠-٩٫٬]/g, (d) => DIGITS[d]);

function translate(lang, text, vars) {
  if (lang === 'en' && typeof text === 'string') return latinDigits(translateRaw(lang, text, vars));
  return translateRaw(lang, text, vars);
}

// Arabic counted nouns after a number ("7 يوم" -> "7 أيام", "67 يوم" -> "67 يوماً").
const COUNTED = {
  'يوم': { one: 'يوم واحد', two: 'يومان', few: 'أيام', many: 'يوماً' },
  'دفعة': { one: 'دفعة واحدة', two: 'دفعتان', few: 'دفعات', many: 'دفعة' },
  'عقد': { one: 'عقد واحد', two: 'عقدان', few: 'عقود', many: 'عقداً' },
  'مالك': { one: 'مالك واحد', two: 'مالكان', few: 'ملاك', many: 'مالكاً' },
  'وحدة': { one: 'وحدة واحدة', two: 'وحدتان', few: 'وحدات', many: 'وحدة' },
  'طلب': { one: 'طلب واحد', two: 'طلبان', few: 'طلبات', many: 'طلباً' },
  'مستأجر': { one: 'مستأجر واحد', two: 'مستأجران', few: 'مستأجرين', many: 'مستأجراً' },
  'سجل': { one: 'سجل واحد', two: 'سجلان', few: 'سجلات', many: 'سجلاً' },
  'مكتب': { one: 'مكتب واحد', two: 'مكتبان', few: 'مكاتب', many: 'مكتباً' },
  'إجراء': { one: 'إجراء واحد', two: 'إجراءان', few: 'إجراءات', many: 'إجراءً' },
  'إعلان': { one: 'إعلان واحد', two: 'إعلانان', few: 'إعلانات', many: 'إعلاناً' },
};
// English forms for countOf (singular, plural).
const COUNTED_EN = {
  'يوم': ['day', 'days'], 'دفعة': ['payment', 'payments'], 'عقد': ['contract', 'contracts'], 'مالك': ['landlord', 'landlords'],
  'وحدة': ['unit', 'units'], 'طلب': ['request', 'requests'], 'مستأجر': ['tenant', 'tenants'], 'سجل': ['entry', 'entries'],
  'مكتب': ['office', 'offices'], 'إجراء': ['action', 'actions'], 'إعلان': ['listing', 'listings'],
};

/** "n noun" in the page language: correct Arabic counted form, or English singular/plural. */
function countOf(n, noun, lang) {
  if (lang === 'en' && COUNTED_EN[noun]) return `${n} ${Number(n) === 1 ? COUNTED_EN[noun][0] : COUNTED_EN[noun][1]}`;
  return arCount(n, noun);
}
const COUNTED_RE = /(^|[^\d.,\-/])(\d+) (يوم|دفعة|عقد)(?=$|[\s.،:؛)]|<)/g;

/** The Arabic phrase for n of a counted noun: 1 يوم واحد, 2 يومان, 3-10 أيام, 11-99 يوماً, 100 يوم. */
function arCount(n, noun) {
  const forms = COUNTED[noun];
  const num = Number(n);
  if (!forms || !Number.isInteger(num) || num < 0) return `${n} ${noun}`;
  if (num === 1) return forms.one;
  if (num === 2) return forms.two;
  const r = num % 100;
  if (r >= 3 && r <= 10) return `${num} ${forms.few}`;
  if (r >= 11) return `${num} ${forms.many}`;
  return `${num} ${noun}`;
}

function fixCounts(text) {
  return typeof text === 'string' ? text.replace(COUNTED_RE, (m, pre, n, noun) => pre + arCount(n, noun)) : text;
}

function translateRaw(lang, text, vars) {
  if (text === null || text === undefined) return text;
  if (typeof text !== 'string') return text;
  if (lang !== 'en' || !ARABIC.test(text)) return lang === 'en' ? fill(text, vars) : fixCounts(fill(text, vars));
  // A multi-line text (an email or a notification body): line by line.
  if (/\n/.test(text.trim())) return text.split('\n').map((line) => translateRaw(lang, line, vars)).join('\n');
  const lead = text.match(/^\s*/)[0];
  const trail = text.match(/\s*$/)[0];
  const key = norm(text);
  const hit = exact.get(key);
  if (hit !== undefined) return lead + fill(hit, vars) + trail;
  // Trailing punctuation is not part of a key ("... حرفاً)." finds "... حرفاً)").
  const bare = key.replace(/[.،؛:]+$/, '');
  if (bare !== key && exact.has(bare)) return lead + fill(exact.get(bare), vars) + key.slice(bare.length).replace('،', ',').replace('؛', ';') + trail;
  // Templates: first one whose parts all become free of Arabic; then one with
  // Arabic words of its own (its parts may be the user's own text, like a
  // unit name). A template made only of separators ("{0}: {1}") never wins
  // with an Arabic part left, so the user's text is never re-punctuated.
  let fallback = null;
  for (const t of templates) {
    const m = key.match(t.re);
    if (!m) continue;
    const parts = {};
    t.names.forEach((name, i) => { parts[name] = translateRaw(lang, m[i + 1]); });
    const out = lead + fill(t.en, { ...parts, ...(vars || {}) }) + trail;
    if (!Object.values(parts).some((v) => ARABIC_LETTER.test(v))) return out;
    if (!fallback && t.words) fallback = out;
  }
  if (fallback) return fallback;
  return fill(text, vars);
}

/** 'ar' or 'en' from anything (default Arabic). */
function langOf(value) {
  return LANGS.includes(value) ? value : 'ar';
}

load();

module.exports = { arCount, countOf, fixCounts, translate, load, langOf, LANGS, FILE };
