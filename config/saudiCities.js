'use strict';

// Saudi cities offered in forms (Riyadh first), with the English spellings
// people type, and normalizeCity() to match any of them. Pure: no database.

const REGIONS = [
  { key: 'riyadh_region', ar: 'منطقة الرياض', en: 'Riyadh Region' },
  { key: 'makkah_region', ar: 'منطقة مكة المكرمة', en: 'Makkah Region' },
  { key: 'eastern_region', ar: 'المنطقة الشرقية', en: 'Eastern Province' },
  { key: 'madinah_region', ar: 'منطقة المدينة المنورة', en: 'Madinah Region' },
  { key: 'qassim_region', ar: 'منطقة القصيم', en: 'Al Qassim Region' },
  { key: 'asir_region', ar: 'منطقة عسير', en: 'Asir Region' },
  { key: 'tabuk_region', ar: 'منطقة تبوك', en: 'Tabuk Region' },
  { key: 'hail_region', ar: 'منطقة حائل', en: 'Hail Region' },
  { key: 'northern_region', ar: 'منطقة الحدود الشمالية', en: 'Northern Borders Region' },
  { key: 'jazan_region', ar: 'منطقة جازان', en: 'Jazan Region' },
  { key: 'najran_region', ar: 'منطقة نجران', en: 'Najran Region' },
  { key: 'baha_region', ar: 'منطقة الباحة', en: 'Al Baha Region' },
  { key: 'jouf_region', ar: 'منطقة الجوف', en: 'Al Jouf Region' },
];

// Cities grouped by region (the region's capital first, Riyadh first overall).
const CITIES = [
  // Riyadh Region
  { key: 'riyadh', ar: 'الرياض', en: ['riyadh', 'riyad'], region: 'riyadh_region' },
  { key: 'kharj', ar: 'الخرج', en: ['kharj'], region: 'riyadh_region' },
  { key: 'diriyah', ar: 'الدرعية', en: ['diriyah'], region: 'riyadh_region' },
  { key: 'majmaah', ar: 'المجمعة', en: ['majmaah', 'majmaa'], region: 'riyadh_region' },
  { key: 'zulfi', ar: 'الزلفي', en: ['zulfi'], region: 'riyadh_region' },
  { key: 'shaqra', ar: 'شقراء', en: ['shaqra'], region: 'riyadh_region' },
  { key: 'dawadmi', ar: 'الدوادمي', en: ['dawadmi'], region: 'riyadh_region' },
  { key: 'afif', ar: 'عفيف', en: ['afif'], region: 'riyadh_region' },
  { key: 'quwayiyah', ar: 'القويعية', en: ['quwayiyah'], region: 'riyadh_region' },
  { key: 'wadi_aldawasir', ar: 'وادي الدواسر', en: ['wadi aldawasir'], region: 'riyadh_region' },
  { key: 'aflaj', ar: 'الأفلاج', en: ['aflaj'], region: 'riyadh_region' },
  { key: 'sulayyil', ar: 'السليل', en: ['sulayyil'], region: 'riyadh_region' },
  { key: 'hawtat_bani_tamim', ar: 'حوطة بني تميم', en: ['hawtat bani tamim'], region: 'riyadh_region' },
  { key: 'hariq', ar: 'الحريق', en: ['hariq'], region: 'riyadh_region' },
  { key: 'dilam', ar: 'الدلم', en: ['dilam'], region: 'riyadh_region' },
  { key: 'muzahimiyah', ar: 'المزاحمية', en: ['muzahimiyah'], region: 'riyadh_region' },
  { key: 'dhurma', ar: 'ضرما', en: ['dhurma'], region: 'riyadh_region' },
  { key: 'rumah', ar: 'رماح', en: ['rumah'], region: 'riyadh_region' },
  { key: 'thadiq', ar: 'ثادق', en: ['thadiq'], region: 'riyadh_region' },
  { key: 'huraymila', ar: 'حريملاء', en: ['huraymila'], region: 'riyadh_region' },
  { key: 'ghat', ar: 'الغاط', en: ['ghat'], region: 'riyadh_region' },
  { key: 'marat', ar: 'مرات', en: ['marat'], region: 'riyadh_region' },
  // Makkah Region
  { key: 'makkah', ar: 'مكة المكرمة', en: ['makkah', 'mecca', 'makkah almukarramah'], alt: ['مكة'], region: 'makkah_region' },
  { key: 'jeddah', ar: 'جدة', en: ['jeddah', 'jiddah', 'jedda'], region: 'makkah_region' },
  { key: 'taif', ar: 'الطائف', en: ['taif'], region: 'makkah_region' },
  { key: 'rabigh', ar: 'رابغ', en: ['rabigh'], region: 'makkah_region' },
  { key: 'jumum', ar: 'الجموم', en: ['jumum'], region: 'makkah_region' },
  { key: 'bahrah', ar: 'بحرة', en: ['bahrah'], region: 'makkah_region' },
  { key: 'khulais', ar: 'خليص', en: ['khulais'], region: 'makkah_region' },
  { key: 'kamil', ar: 'الكامل', en: ['kamil'], region: 'makkah_region' },
  { key: 'lith', ar: 'الليث', en: ['lith'], region: 'makkah_region' },
  { key: 'qunfudhah', ar: 'القنفذة', en: ['qunfudhah'], region: 'makkah_region' },
  { key: 'adham', ar: 'أضم', en: ['adham'], region: 'makkah_region' },
  { key: 'ardiyat', ar: 'العرضيات', en: ['ardiyat'], region: 'makkah_region' },
  { key: 'khurmah', ar: 'الخرمة', en: ['khurmah'], region: 'makkah_region' },
  { key: 'ranyah', ar: 'رنية', en: ['ranyah'], region: 'makkah_region' },
  { key: 'turabah', ar: 'تربة', en: ['turabah'], region: 'makkah_region' },
  { key: 'muwayh', ar: 'المويه', en: ['muwayh'], region: 'makkah_region' },
  { key: 'maysan', ar: 'ميسان', en: ['maysan'], region: 'makkah_region' },
  // Eastern Province
  { key: 'dammam', ar: 'الدمام', en: ['dammam'], region: 'eastern_region' },
  { key: 'khobar', ar: 'الخبر', en: ['khobar'], region: 'eastern_region' },
  { key: 'dhahran', ar: 'الظهران', en: ['dhahran'], region: 'eastern_region' },
  { key: 'ahsa', ar: 'الأحساء', en: ['ahsa', 'hasa', 'hofuf'], alt: ['الهفوف'], region: 'eastern_region' },
  { key: 'qatif', ar: 'القطيف', en: ['qatif'], region: 'eastern_region' },
  { key: 'jubail', ar: 'الجبيل', en: ['jubail'], region: 'eastern_region' },
  { key: 'hafar_albatin', ar: 'حفر الباطن', en: ['hafar albatin', 'hafr albatin'], region: 'eastern_region' },
  { key: 'khafji', ar: 'الخفجي', en: ['khafji'], region: 'eastern_region' },
  { key: 'ras_tanura', ar: 'رأس تنورة', en: ['ras tanura'], region: 'eastern_region' },
  { key: 'abqaiq', ar: 'بقيق', en: ['abqaiq'], region: 'eastern_region' },
  { key: 'nairyah', ar: 'النعيرية', en: ['nairyah'], region: 'eastern_region' },
  { key: 'qaryat_al_ulya', ar: 'قرية العليا', en: ['qaryat al ulya'], region: 'eastern_region' },
  // Madinah Region
  { key: 'madinah', ar: 'المدينة المنورة', en: ['madinah', 'medina', 'madina', 'madinah almunawwarah'], alt: ['المدينة'], region: 'madinah_region' },
  { key: 'yanbu', ar: 'ينبع', en: ['yanbu', 'yanbu albahr'], region: 'madinah_region' },
  { key: 'ula', ar: 'العلا', en: ['ula'], region: 'madinah_region' },
  { key: 'badr', ar: 'بدر', en: ['badr'], region: 'madinah_region' },
  { key: 'khaybar', ar: 'خيبر', en: ['khaybar'], region: 'madinah_region' },
  { key: 'mahd', ar: 'المهد', en: ['mahd'], region: 'madinah_region' },
  { key: 'hanakiyah', ar: 'الحناكية', en: ['hanakiyah'], region: 'madinah_region' },
  { key: 'ais', ar: 'العيص', en: ['ais'], region: 'madinah_region' },
  { key: 'wadi_alfaraa', ar: 'وادي الفرع', en: ['wadi alfaraa'], region: 'madinah_region' },
  // Al Qassim Region
  { key: 'buraydah', ar: 'بريدة', en: ['buraydah', 'buraidah', 'buraida'], region: 'qassim_region' },
  { key: 'unaizah', ar: 'عنيزة', en: ['unaizah', 'unayzah', 'onaizah'], region: 'qassim_region' },
  { key: 'rass', ar: 'الرس', en: ['rass'], region: 'qassim_region' },
  { key: 'midhnab', ar: 'المذنب', en: ['midhnab'], region: 'qassim_region' },
  { key: 'bukayriyah', ar: 'البكيرية', en: ['bukayriyah'], region: 'qassim_region' },
  { key: 'badai', ar: 'البدائع', en: ['badai'], region: 'qassim_region' },
  { key: 'asyah', ar: 'الأسياح', en: ['asyah'], region: 'qassim_region' },
  { key: 'nabhaniyah', ar: 'النبهانية', en: ['nabhaniyah'], region: 'qassim_region' },
  { key: 'uyun_aljiwa', ar: 'عيون الجواء', en: ['uyun aljiwa'], region: 'qassim_region' },
  { key: 'riyadh_alkhabra', ar: 'رياض الخبراء', en: ['riyadh alkhabra'], region: 'qassim_region' },
  { key: 'shimasiyah', ar: 'الشماسية', en: ['shimasiyah'], region: 'qassim_region' },
  { key: 'uqlat_assuqur', ar: 'عقلة الصقور', en: ['uqlat assuqur'], region: 'qassim_region' },
  { key: 'dariyah', ar: 'ضرية', en: ['dariyah'], region: 'qassim_region' },
  // Asir Region
  { key: 'abha', ar: 'أبها', en: ['abha'], region: 'asir_region' },
  { key: 'khamis_mushait', ar: 'خميس مشيط', en: ['khamis mushait', 'khamis mushayt'], region: 'asir_region' },
  { key: 'bisha', ar: 'بيشة', en: ['bisha', 'bishah'], region: 'asir_region' },
  { key: 'namas', ar: 'النماص', en: ['namas'], region: 'asir_region' },
  { key: 'muhayil', ar: 'محايل عسير', en: ['muhayil'], region: 'asir_region' },
  { key: 'sarat_abidah', ar: 'سراة عبيدة', en: ['sarat abidah'], region: 'asir_region' },
  { key: 'rijal_almaa', ar: 'رجال ألمع', en: ['rijal almaa'], region: 'asir_region' },
  { key: 'ahad_rafidah', ar: 'أحد رفيدة', en: ['ahad rafidah'], region: 'asir_region' },
  { key: 'dhahran_aljanub', ar: 'ظهران الجنوب', en: ['dhahran aljanub'], region: 'asir_region' },
  { key: 'tathlith', ar: 'تثليث', en: ['tathlith'], region: 'asir_region' },
  { key: 'majardah', ar: 'المجاردة', en: ['majardah'], region: 'asir_region' },
  { key: 'balqarn', ar: 'بلقرن', en: ['balqarn'], region: 'asir_region' },
  { key: 'tanomah', ar: 'تنومة', en: ['tanomah'], region: 'asir_region' },
  // Tabuk Region
  { key: 'tabuk', ar: 'تبوك', en: ['tabuk'], region: 'tabuk_region' },
  { key: 'wajh', ar: 'الوجه', en: ['wajh'], region: 'tabuk_region' },
  { key: 'duba', ar: 'ضباء', en: ['duba'], region: 'tabuk_region' },
  { key: 'tayma', ar: 'تيماء', en: ['tayma'], region: 'tabuk_region' },
  { key: 'umluj', ar: 'أملج', en: ['umluj'], region: 'tabuk_region' },
  { key: 'haql', ar: 'حقل', en: ['haql'], region: 'tabuk_region' },
  { key: 'bad', ar: 'البدع', en: ['bad'], region: 'tabuk_region' },
  // Hail Region
  { key: 'hail', ar: 'حائل', en: ['hail', 'hayil'], region: 'hail_region' },
  { key: 'baqaa', ar: 'بقعاء', en: ['baqaa'], region: 'hail_region' },
  { key: 'ghazalah', ar: 'الغزالة', en: ['ghazalah'], region: 'hail_region' },
  { key: 'shinan', ar: 'الشنان', en: ['shinan'], region: 'hail_region' },
  { key: 'hait', ar: 'الحائط', en: ['hait'], region: 'hail_region' },
  { key: 'sulaymi', ar: 'السليمي', en: ['sulaymi'], region: 'hail_region' },
  { key: 'shamli', ar: 'الشملي', en: ['shamli'], region: 'hail_region' },
  { key: 'mawqaq', ar: 'موقق', en: ['mawqaq'], region: 'hail_region' },
  // Northern Borders Region
  { key: 'arar', ar: 'عرعر', en: ['arar'], region: 'northern_region' },
  { key: 'rafha', ar: 'رفحاء', en: ['rafha'], region: 'northern_region' },
  { key: 'turaif', ar: 'طريف', en: ['turaif'], region: 'northern_region' },
  { key: 'uwayqilah', ar: 'العويقيلة', en: ['uwayqilah'], region: 'northern_region' },
  // Jazan Region
  { key: 'jazan', ar: 'جازان', en: ['jazan', 'jizan', 'gizan'], region: 'jazan_region' },
  { key: 'sabya', ar: 'صبيا', en: ['sabya'], region: 'jazan_region' },
  { key: 'abu_arish', ar: 'أبو عريش', en: ['abu arish'], region: 'jazan_region' },
  { key: 'samtah', ar: 'صامطة', en: ['samtah'], region: 'jazan_region' },
  { key: 'baish', ar: 'بيش', en: ['baish'], region: 'jazan_region' },
  { key: 'darb', ar: 'الدرب', en: ['darb'], region: 'jazan_region' },
  { key: 'damad', ar: 'ضمد', en: ['damad'], region: 'jazan_region' },
  { key: 'ahad_almasarihah', ar: 'أحد المسارحة', en: ['ahad almasarihah'], region: 'jazan_region' },
  { key: 'aridah', ar: 'العارضة', en: ['aridah'], region: 'jazan_region' },
  { key: 'dair', ar: 'الداير', en: ['dair'], region: 'jazan_region' },
  { key: 'aydabi', ar: 'العيدابي', en: ['aydabi'], region: 'jazan_region' },
  { key: 'farasan', ar: 'فرسان', en: ['farasan'], region: 'jazan_region' },
  // Najran Region
  { key: 'najran', ar: 'نجران', en: ['najran'], region: 'najran_region' },
  { key: 'sharurah', ar: 'شرورة', en: ['sharurah'], region: 'najran_region' },
  { key: 'hubuna', ar: 'حبونا', en: ['hubuna'], region: 'najran_region' },
  { key: 'badr_aljanub', ar: 'بدر الجنوب', en: ['badr aljanub'], region: 'najran_region' },
  { key: 'yadamah', ar: 'يدمة', en: ['yadamah'], region: 'najran_region' },
  { key: 'thar', ar: 'ثار', en: ['thar'], region: 'najran_region' },
  { key: 'khubash', ar: 'خباش', en: ['khubash'], region: 'najran_region' },
  // Al Baha Region
  { key: 'baha', ar: 'الباحة', en: ['baha', 'bahah'], region: 'baha_region' },
  { key: 'baljurashi', ar: 'بلجرشي', en: ['baljurashi'], region: 'baha_region' },
  { key: 'mandaq', ar: 'المندق', en: ['mandaq'], region: 'baha_region' },
  { key: 'mikhwah', ar: 'المخواة', en: ['mikhwah'], region: 'baha_region' },
  { key: 'qilwah', ar: 'قلوة', en: ['qilwah'], region: 'baha_region' },
  { key: 'aqiq', ar: 'العقيق', en: ['aqiq'], region: 'baha_region' },
  { key: 'qura', ar: 'القرى', en: ['qura'], region: 'baha_region' },
  // Al Jouf Region
  { key: 'sakaka', ar: 'سكاكا', en: ['sakaka', 'sakakah'], region: 'jouf_region' },
  { key: 'qurayyat', ar: 'القريات', en: ['qurayyat', 'qurayat'], region: 'jouf_region' },
  { key: 'dumat_aljandal', ar: 'دومة الجندل', en: ['dumat aljandal'], region: 'jouf_region' },
  { key: 'tabarjal', ar: 'طبرجل', en: ['tabarjal'], region: 'jouf_region' },
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

const OTHER_CITY = SAUDI_CITIES[SAUDI_CITIES.length - 1];

/** Region groups for <optgroup> dropdowns: [{ label, cities: [arabic names] }]. */
const CITY_GROUPS = Object.freeze(REGIONS.map((r) => Object.freeze({
  key: r.key,
  label: r.ar,
  cities: Object.freeze(CITIES.filter((c) => c.region === r.key).map((c) => c.ar)),
})));

module.exports = { SAUDI_CITIES, CITIES, REGIONS, CITY_GROUPS, OTHER_CITY, normalizeCity };
