'use strict';

// The optional analytics snippet (platform setting 'analytics.snippet', empty
// by default). Only ONE external script tag from a known analytics provider is
// accepted; it is rebuilt from the parsed attributes, so nothing else the
// admin pasted (inline code, event handlers, other tags) can reach a page.

const ALLOWED_HOSTS = Object.freeze([
  'www.googletagmanager.com',
  'www.google-analytics.com',
  'plausible.io',
  'cdn.usefathom.com',
  'static.cloudflareinsights.com',
  'cloud.umami.is',
  'analytics.umami.is',
  'scripts.simpleanalyticscdn.com',
]);
// Extra origins a provider's script talks to (connect-src / img-src).
const EXTRA_ORIGINS = Object.freeze({
  'www.googletagmanager.com': ['https://*.google-analytics.com', 'https://*.analytics.google.com', 'https://www.googletagmanager.com'],
  'www.google-analytics.com': ['https://*.google-analytics.com', 'https://*.analytics.google.com'],
  'plausible.io': ['https://plausible.io'],
  'cdn.usefathom.com': ['https://cdn.usefathom.com'],
  'static.cloudflareinsights.com': ['https://cloudflareinsights.com'],
  'cloud.umami.is': ['https://cloud.umami.is', 'https://api-gateway.umami.dev'],
  'analytics.umami.is': ['https://analytics.umami.is'],
  'scripts.simpleanalyticscdn.com': ['https://queue.simpleanalyticscdn.com'],
});
const FLAGS = new Set(['async', 'defer']);
const DATA_ATTRIBUTE = /^data-[a-z0-9-]{1,40}$/;
const SAFE_VALUE = /^[A-Za-z0-9._:/@?=&#,-]{1,300}$/;

/**
 * Checks and rebuilds a pasted snippet. Returns { ok: true, snippet, origins }
 * ('' is fine: analytics off) or { ok: false, error } with an Arabic message.
 */
function sanitizeSnippet(input) {
  const text = String(input ?? '').trim();
  if (!text) return { ok: true, snippet: '', origins: [] };
  if (text.length > 1000) return { ok: false, error: 'الشيفرة طويلة. الصق وسماً واحداً فقط.' };
  const match = /^<script\b([^<>]*)>\s*<\/script>$/i.exec(text);
  if (!match) return { ok: false, error: 'الصق وسم <script src="..."></script> واحداً فقط، بدون شيفرة داخلية.' };

  const attrs = new Map();
  const pattern = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g;
  let rest = match[1];
  let m;
  while ((m = pattern.exec(rest)) !== null) {
    const name = m[1].toLowerCase();
    const value = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : '';
    if (attrs.has(name)) return { ok: false, error: 'سمة مكررة في الوسم.' };
    attrs.set(name, value);
  }
  // Anything the pattern could not read (stray quotes, odd characters) is refused.
  rest = rest.replace(pattern, '').trim();
  if (rest) return { ok: false, error: 'الوسم يحتوي على جزء غير مفهوم.' };

  const src = attrs.get('src');
  let url;
  try {
    url = new URL(src);
  } catch {
    return { ok: false, error: 'عنوان الشيفرة (src) غير صحيح.' };
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !ALLOWED_HOSTS.includes(url.hostname)) {
    return { ok: false, error: `المزوّد غير مسموح. المسموح: ${ALLOWED_HOSTS.join('، ')}.` };
  }
  if (!SAFE_VALUE.test(src)) return { ok: false, error: 'عنوان الشيفرة يحتوي على رموز غير مسموحة.' };

  const parts = [`src="${src}"`];
  for (const [name, value] of attrs) {
    if (name === 'src') continue;
    if (FLAGS.has(name)) {
      if (value !== '') return { ok: false, error: `السمة ${name} لا تأخذ قيمة.` };
      parts.push(name);
    } else if (DATA_ATTRIBUTE.test(name)) {
      if (!SAFE_VALUE.test(value)) return { ok: false, error: `قيمة ${name} تحتوي على رموز غير مسموحة.` };
      parts.push(`${name}="${value}"`);
    } else {
      return { ok: false, error: `السمة ${name} غير مسموحة.` };
    }
  }
  return { ok: true, snippet: `<script ${parts.join(' ')}></script>`, origins: EXTRA_ORIGINS[url.hostname] || [`https://${url.hostname}`] };
}

/** Adds the provider's origins to script-src, connect-src and img-src of a Content-Security-Policy header. */
function extendCsp(header, origins) {
  if (!origins.length) return header;
  const extra = origins.join(' ');
  return header
    .split(';')
    .map((part) => (/^\s*(script-src|connect-src|img-src)\s/.test(part) ? `${part} ${extra}` : part))
    .join(';');
}

module.exports = { ALLOWED_HOSTS, sanitizeSnippet, extendCsp };
