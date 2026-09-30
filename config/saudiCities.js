'use strict';

// Saudi cities offered in forms (Riyadh first), with the English spellings
// people type, and normalizeCity() to match any of them. Pure: no database.

const CITIES = [
  { key: 'riyadh', ar: 'الرياض', en: ['riyadh', 'riyad'] },
  { key: 'jeddah', ar: 'جدة', en: ['jeddah', 'jiddah', 'jedda'] },
  { key: 'makkah', ar: 'مكة المكرمة', en: ['makkah', 'mecca', 'makkah almukarramah'], alt: ['مكة'] },
  { key: 'madinah', ar: 'المدينة المنورة', en: ['madinah', 'medina', 'madina', 'madinah almunawwarah'], alt: ['المدينة'] },
  { key: 'dammam', ar: 'الدمام', en: ['dammam'] },
  { key: 'khobar', ar: 'الخبر', en: ['khobar'] },
  { key: 'dhahran', ar: 'الظهران', en: ['dhahran'] },
  { key: 'ahsa', ar: 'الأحساء', en: ['ahsa', 'hasa', 'hofuf'], alt: ['الهفوف'] },
  { key: 'jubail', ar: 'الجبيل', en: ['jubail'] },
  { key: 'qatif', ar: 'القطيف', en: ['qatif'] },
  { key: 'taif', ar: 'الطائف', en: ['taif'] },
  { key: 'tabuk', ar: 'تبوك', en: ['tabuk'] },
  { key: 'buraydah', ar: 'بريدة', en: ['buraydah', 'buraidah', 'buraida'] },
  { key: 'unaizah', ar: 'عنيزة', en: ['unaizah', 'unayzah', 'onaizah'] },
  { key: 'rass', ar: 'الرس', en: ['rass'] },
  { key: 'hail', ar: 'حائل', en: ['hail', 'hayil'] },
  { key: 'abha', ar: 'أبها', en: ['abha'] },
  { key: 'khamis_mushait', ar: 'خميس مشيط', en: ['khamis mushait', 'khamis mushayt'] },
  { key: 'jazan', ar: 'جازان', en: ['jazan', 'jizan', 'gizan'] },
  { key: 'najran', ar: 'نجران', en: ['najran'] },
  { key: 'baha', ar: 'الباحة', en: ['baha', 'bahah'] },
  { key: 'bisha', ar: 'بيشة', en: ['bisha', 'bishah'] },
  { key: 'yanbu', ar: 'ينبع', en: ['yanbu', 'yanbu albahr'] },
  { key: 'hafar_albatin', ar: 'حفر الباطن', en: ['hafar albatin', 'hafr albatin'] },
  { key: 'kharj', ar: 'الخرج', en: ['kharj'] },
  { key: 'majmaah', ar: 'المجمعة', en: ['majmaah', 'majmaa'] },
  { key: 'dawadmi', ar: 'الدوادمي', en: ['dawadmi'] },
  { key: 'arar', ar: 'عرعر', en: ['arar'] },
  { key: 'sakaka', ar: 'سكاكا', en: ['sakaka', 'sakakah'] },
  { key: 'qurayyat', ar: 'القريات', en: ['qurayyat', 'qurayat'] },
];

// The Arabic names shown in dropdowns; the last option is a catch-all.
const SAUDI_CITIES = Object.freeze([...CITIES.map((c) => c.ar), 'مدينة أخرى']);

/** Arabic: no diacritics or tatweel, one form of alef/yaa/taa marbuta, single spaces. */
function normalizeArabic(text) {
  return text
    .replace(/[ً-ْٰـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Latin: lower case, letters only, without a leading "al-/ar-/ad-/..." article. */
function normalizeLatin(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/^(al|ar|ad|as|az|an|at|el)[\s-]+/, '')
    .replace(/[^a-z]/g, '');
}

const LOOKUP = new Map();
for (const city of CITIES) {
  for (const name of [city.ar, ...(city.alt || [])]) LOOKUP.set(`ar:${normalizeArabic(name)}`, city.key);
  for (const name of city.en) {
    LOOKUP.set(`en:${normalizeLatin(name)}`, city.key);
    LOOKUP.set(`en:${normalizeLatin(`al${name}`)}`, city.key); // "AlKhobar" written as one word
  }
}

/**
 * The city key ('riyadh', 'jeddah', ...) for Arabic or English input, in any
 * case and spacing ("الرياض ", "Riyadh", "ar-riyadh"), or null when unknown.
 */
function normalizeCity(input) {
  if (typeof input !== 'string' || !input.trim()) return null;
  return LOOKUP.get(`ar:${normalizeArabic(input)}`) || LOOKUP.get(`en:${normalizeLatin(input)}`) || null;
}

module.exports = { SAUDI_CITIES, CITIES, normalizeCity };
