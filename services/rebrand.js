'use strict';

// The platform's name shown to users changed from «عقدي» to «ميعاد» (Mi3aad).
// Internal identifiers (database, cookies, lock keys, env names, file names)
// keep the old Latin name on purpose.
//
// applyRebrand (run by ensureSchema and the seed) updates seeded default text
// that is already in the database, ONLY where it still equals the old default
// exactly, so anything an admin or an office edited is never touched:
//   - platform message templates (office_id IS NULL),
//   - the FAQ rows, the seeded blog drafts (per column), settings 'site_name'.
// Idempotent: once updated, the stored text no longer equals the old default.

const NAME = 'ميعاد';
const OLD_NAME = 'عقدي';

/** Pure: the old default of a seeded text (the seeds never used the new name before). */
function oldOf(text) {
  return String(text).split(NAME).join(OLD_NAME);
}

async function applyRebrand(pool) {
  // Required here: database/seed.js loads modules that load this file's callers.
  const { TEMPLATES, SETTINGS, BLOG_DRAFTS } = require('../database/seed');
  const { DEFAULT_FAQS } = require('./siteContent');
  let changed = 0;
  const run = async (sql, params) => {
    const [result] = await pool.query(sql, params);
    changed += result.affectedRows;
  };

  for (const t of TEMPLATES) {
    if (oldOf(t.body_ar) === t.body_ar) continue;
    await run(
      'UPDATE message_templates SET body_ar = ? WHERE office_id IS NULL AND code = ? AND channel = ? AND body_ar = ?',
      [t.body_ar, t.code, t.channel, oldOf(t.body_ar)],
    );
  }
  for (const s of SETTINGS) {
    if (oldOf(s.value) === s.value) continue;
    await run('UPDATE settings SET setting_value = ? WHERE setting_key = ? AND setting_value = ?', [s.value, s.key, oldOf(s.value)]);
  }
  for (const [question, answer] of DEFAULT_FAQS) {
    if (oldOf(question) !== question) await run('UPDATE faqs SET question_ar = ? WHERE question_ar = ?', [question, oldOf(question)]);
    if (oldOf(answer) !== answer) await run('UPDATE faqs SET answer_ar = ? WHERE answer_ar = ?', [answer, oldOf(answer)]);
  }
  for (const post of BLOG_DRAFTS) {
    const columns = { title_ar: post.title_ar, excerpt_ar: post.excerpt_ar, body_ar: post.body_ar, meta_description: post.excerpt_ar };
    for (const [column, value] of Object.entries(columns)) {
      if (oldOf(value) === value) continue;
      await run(`UPDATE blog_posts SET \`${column}\` = ? WHERE slug = ? AND \`${column}\` = ?`, [value, post.slug, oldOf(value)]);
    }
  }
  return { changed };
}

module.exports = { NAME, OLD_NAME, oldOf, applyRebrand };
