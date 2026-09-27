const ARABIC_INDIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const EASTERN_ARABIC_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

/** Converts Arabic-Indic and Eastern Arabic digits to 0-9. */
export function toWesternDigits(input: string): string {
  return input.replace(/[٠-٩۰-۹]/g, (digit) => {
    const index = ARABIC_INDIC_DIGITS.indexOf(digit);
    return String(index >= 0 ? index : EASTERN_ARABIC_DIGITS.indexOf(digit));
  });
}

/**
 * Normalizes a Saudi mobile number to E.164 (+9665XXXXXXXX).
 * Accepts 05XXXXXXXX, 5XXXXXXXX, 9665XXXXXXXX, +9665XXXXXXXX or 009665XXXXXXXX,
 * with spaces or dashes. Returns null for anything else.
 */
export function normalizeSaudiPhone(input: string): string | null {
  let digits = toWesternDigits(input).replace(/[\s\-()]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("966")) digits = digits.slice(3);
  if (digits.startsWith("0")) digits = digits.slice(1);
  return /^5\d{8}$/.test(digits) ? `+966${digits}` : null;
}
