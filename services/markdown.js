'use strict';

// A small, safe Markdown subset for the blog, rendered on the server.
// Everything is HTML-escaped FIRST, then only these constructs are turned
// into a fixed set of tags: # / ## (h2) and ### (h3), paragraphs, **bold**,
// *italic*, "- " and "1. " lists, "> " quotes, "---" rules and
// [text](https://… or /path) links. Raw HTML never survives, and links with
// any other scheme (javascript:, data:) are printed as plain text.

const { xmlEscape } = require('./seo');

const URL_OK = /^(https?:\/\/[^\s"'<>()]+|\/[^\s"'<>()]*)$/;

function inline(escaped) {
  return escaped
    .replace(/\[([^\]\n]{1,200})\]\(([^)\s]{1,500})\)/g, (all, text, url) => {
      const raw = url.replace(/&amp;/g, '&');
      if (!URL_OK.test(raw)) return all;
      const external = /^https?:/i.test(raw);
      return `<a href="${xmlEscape(raw)}"${external ? ' rel="nofollow noopener noreferrer"' : ''}>${text}</a>`;
    })
    .replace(/\*\*([^*\n]{1,300})\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]{1,300})\*(?!\*)/g, '$1<em>$2</em>');
}

/** Markdown text -> safe HTML. */
function render(source) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let paragraph = [];
  let list = null; // { tag, items }
  let quote = [];

  const flushParagraph = () => {
    if (paragraph.length) html.push(`<p>${paragraph.map((l) => inline(xmlEscape(l))).join('<br>')}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list) html.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(xmlEscape(i))}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  const flushQuote = () => {
    if (quote.length) html.push(`<blockquote><p>${quote.map((l) => inline(xmlEscape(l))).join('<br>')}</p></blockquote>`);
    quote = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (trimmed === '') {
      flushAll();
      continue;
    }
    let m;
    if ((m = /^(#{1,3})\s+(.+)$/.exec(trimmed))) {
      flushAll();
      const tag = m[1].length === 3 ? 'h3' : 'h2'; // the page title is the only h1
      html.push(`<${tag}>${inline(xmlEscape(m[2]))}</${tag}>`);
    } else if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      flushAll();
      html.push('<hr>');
    } else if ((m = /^[-*]\s+(.+)$/.exec(trimmed))) {
      flushParagraph();
      flushQuote();
      if (!list || list.tag !== 'ul') {
        flushList();
        list = { tag: 'ul', items: [] };
      }
      list.items.push(m[1]);
    } else if ((m = /^\d{1,3}[.)]\s+(.+)$/.exec(trimmed))) {
      flushParagraph();
      flushQuote();
      if (!list || list.tag !== 'ol') {
        flushList();
        list = { tag: 'ol', items: [] };
      }
      list.items.push(m[1]);
    } else if ((m = /^>\s?(.*)$/.exec(trimmed))) {
      flushParagraph();
      flushList();
      quote.push(m[1]);
    } else {
      flushList();
      flushQuote();
      paragraph.push(trimmed);
    }
  }
  flushAll();
  return html.join('\n');
}

/** Plain text of a markdown source (for descriptions and feeds): no markup, one line. */
function plain(source, max = 200) {
  return String(source ?? '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

module.exports = { render, plain };
