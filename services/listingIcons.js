'use strict';

// Small line icons for the public listing pages (static SVG paths, no user input).

const PATHS = Object.freeze({
  pin: '<path d="M12 21s-7-6.1-7-11.5A7 7 0 0 1 19 9.5C19 14.9 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  bed: '<path d="M3 18V7M3 13h18v5M21 18v-3.5a3 3 0 0 0-3-3h-7v4.5"/><circle cx="7" cy="10.5" r="1.8"/>',
  bath: '<path d="M4 12h16v3a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4v-3zM6 12V6a2 2 0 0 1 4 0M7 19l-1 2M17 19l1 2"/>',
  area: '<path d="M4 4h6M4 4v6M20 20h-6M20 20v-6M4 4l16 16"/>',
  home: '<path d="M4 11 12 4l8 7v9H4z"/><path d="M10 20v-5h4v5"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  shield: '<path d="M12 3 5 6v6c0 4.2 3 7.6 7 9 4-1.4 7-4.8 7-9V6z"/><path d="m9 12 2 2 4-4"/>',
  photos: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="m21 16-5-5-8 8"/>',
  office: '<path d="M4 20V6l8-3v17M12 9h8v11M8 8v.01M8 12v.01M8 16v.01M16 13v.01M16 17v.01"/>',
  cal: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  ac: '<rect x="3" y="5" width="18" height="8" rx="2"/><path d="M7 17v2M12 17v3M17 17v2M7 10h10"/>',
  kitchen: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M5 10h14M9 6.5h.01M13 6.5h.01"/>',
  parking: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M10 16V8h3a2.5 2.5 0 0 1 0 5h-3"/>',
  elevator: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="m9 9 3-3 3 3M9 15l3 3 3-3"/>',
  guard: '<path d="M12 3 5 6v6c0 4.2 3 7.6 7 9 4-1.4 7-4.8 7-9V6z"/>',
  pool: '<path d="M3 17c2 0 2-1.5 4.5-1.5S10 17 12 17s2.5-1.5 4.5-1.5S19 17 21 17M8 14V5a2 2 0 0 1 4 0M16 14V5a2 2 0 0 0-4 0M8 9h8"/>',
  gym: '<path d="M6 8v8M18 8v8M3 10v4M21 10v4M6 12h12"/>',
  internet: '<path d="M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0M12 19.5h.01"/>',
  central_gas: '<path d="M12 3c3 4 6 6.5 6 10.5a6 6 0 0 1-12 0C6 10 9 8 9 5.5c1.5 1 3 2.5 3 4.5"/>',
  maid_room: '<path d="M4 21V9l8-5 8 5v12M9 21v-6h6v6"/>',
  furnished: '<path d="M4 12V9a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3M3 12h18v5H3zM5 17v2M19 17v2"/>',
});

/** SVG markup for a named icon (unknown names get the check mark). */
function icon(name, cls = 'li-icon') {
  const safeClass = String(cls).replace(/[^a-z0-9_ -]/gi, '');
  return `<svg class="${safeClass}" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${PATHS[name] || PATHS.check}</svg>`;
}

module.exports = { icon, PATHS };
