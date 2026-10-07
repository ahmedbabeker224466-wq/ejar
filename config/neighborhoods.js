'use strict';

// The fixed neighborhood (حي) lists a public listing may use. A listing never
// shows more than the city and one of these areas: no street, plot or
// building. Cities without a list offer only OTHER. Pure: no database.

const OTHER = 'أخرى';

const BY_CITY = Object.freeze({
  'الرياض': ['الملقا', 'النرجس', 'الياسمين', 'العارض', 'حطين', 'الصحافة', 'الربيع', 'الملز', 'السليمانية', 'العليا', 'المروج', 'الشفا', 'العزيزية', 'قرطبة', 'النخيل'],
  'جدة': ['الروضة', 'الحمراء', 'الشاطئ', 'النعيم', 'السلامة', 'أبحر الشمالية', 'الصفا', 'المرجان', 'الزهراء', 'البوادي', 'الفيصلية', 'النسيم'],
  'مكة المكرمة': ['العزيزية', 'الشوقية', 'الزاهر', 'النسيم', 'العوالي', 'الرصيفة', 'الشرائع', 'ولي العهد'],
  'المدينة المنورة': ['قباء', 'العزيزية', 'الحرة الشرقية', 'العوالي', 'شوران', 'الخالدية', 'الجمعة', 'بني ظفر'],
  'الدمام': ['الفيصلية', 'الشاطئ', 'المزروعية', 'الجلوية', 'الريان', 'النور', 'الفرسان', 'أحد'],
  'الخبر': ['العقربية', 'الراكة', 'الثقبة', 'الحزام الذهبي', 'الخزامى', 'اليرموك', 'الحمراء', 'الجسر'],
});

/** The areas offered for a city, always ending with OTHER. */
function neighborhoodsFor(city) {
  return [...(Object.hasOwn(BY_CITY, city) ? BY_CITY[city] : []), OTHER];
}

/** Whether `value` is one of the offered areas of `city`. */
function isNeighborhood(city, value) {
  return neighborhoodsFor(city).includes(value);
}

module.exports = { OTHER, BY_CITY, neighborhoodsFor, isNeighborhood };
