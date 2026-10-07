'use strict';

// Checks for text that will be shown on a public page or sent by a visitor.
// Contact details never go in public text: people reach the office through the
// in-app inquiry form. These checks catch the usual ways to sneak one in.

const { toWesternDigits } = require('../utils/phone');

/** Trims, normalizes digits and control characters; keeps single line breaks. */
function cleanText(value, max, { multiline = false } = {}) {
  let text = toWesternDigits(String(value ?? '')).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  text = multiline ? text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n') : text.replace(/\s+/g, ' ');
  return text.trim().slice(0, max);
}

/**
 * What kind of contact detail a text contains, or null:
 * 'phone' | 'url' | 'email' | 'iban'. Digits in any script count.
 */
function findContact(input) {
  const text = toWesternDigits(String(input ?? ''));
  const squeezed = text.replace(/[\s\-._/]/g, '');
  if (/[A-Za-z]{2}\d{2}[A-Za-z0-9]{10,30}/.test(squeezed)) return 'iban';
  // A run of 7+ digits, even when split by spaces, dots, dashes or brackets.
  if (/\d{7,}/.test(text.replace(/(?<=\d)[\s.\-()_/\\](?=\d)/g, '').replace(/\+(?=\d)/g, ''))) return 'phone';
  if (/[^\s@]+@[^\s@]+\.[^\s@]{2,}|(^|\s)@[a-z0-9_.]{3,}/i.test(text)) return 'email';
  if (/https?:\/\/|www\.|\bt\.me\b|\bwa\.me\b|\bbit\.ly\b|\b[a-z0-9-]{2,}\.(com|net|org|sa|app|me|io|co|info|link|ly|xyz|site|online|shop)\b/i.test(text)) return 'url';
  return null;
}

const CONTACT_MESSAGES = {
  phone: 'لا تكتب أرقام هواتف في الوصف. سيتواصل معك العملاء من خلال نموذج الاستفسار.',
  url: 'لا تكتب روابط أو عناوين مواقع في الوصف.',
  email: 'لا تكتب بريداً إلكترونياً أو حساب تواصل في الوصف.',
  iban: 'لا تكتب أرقام حسابات أو آيبان في الوصف.',
};

/** An Arabic message for a contact detail kind. */
const contactMessage = (kind) => CONTACT_MESSAGES[kind] || null;

/** True when the text contains a link (used for the visitor's message). */
function hasLink(input) {
  return findContact(String(input ?? '').replace(/\d/g, '')) === 'url' || /https?:\/\/|www\./i.test(String(input ?? ''));
}

module.exports = { cleanText, findContact, contactMessage, hasLink };
