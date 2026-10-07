'use strict';

// Blog posts: admin CRUD and the public reads. Bodies are Markdown in a safe
// subset (services/markdown.js) and are rendered with escaping on the server.
// A cover image goes through the same image pipeline as photos (re-encoded
// JPEG, no metadata, random name in UPLOAD_DIR) and is served by a route that
// only answers for published posts.

const markdown = require('./markdown');
const images = require('./images');
const { cleanText } = require('./publicText');

const PAGE_SIZE = 12;
const COLUMNS = 'id, slug, title_ar, excerpt_ar, body_ar, cover_path, status, published_at, meta_title, meta_description, needs_review, created_at, updated_at';

/** Checks the post form. Returns { values, errors }. */
function validatePost(body = {}, { creating = false } = {}) {
  const errors = {};
  const values = {};
  if (creating) {
    values.slug = String(body.slug ?? '').trim().toLowerCase();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(values.slug) || values.slug.length < 3 || values.slug.length > 100) {
      errors.slug = 'الرابط حروف إنجليزية صغيرة وأرقام وشرطات (مثل: rent-reminders) من 3 إلى 100 حرف.';
    }
  }
  values.title_ar = cleanText(body.title_ar, 200);
  if (values.title_ar.length < 3) errors.title_ar = 'اكتب عنوان المقال.';
  values.excerpt_ar = cleanText(body.excerpt_ar, 501, { multiline: false });
  if (values.excerpt_ar.length > 500) errors.excerpt_ar = 'الملخص 500 حرف كحد أقصى.';
  values.body_ar = String(body.body_ar ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (values.body_ar.length < 20) errors.body_ar = 'اكتب نص المقال (20 حرفاً على الأقل).';
  else if (values.body_ar.length > 60000) errors.body_ar = 'النص طويل جداً.';
  values.meta_title = cleanText(body.meta_title, 161);
  if (values.meta_title.length > 160) errors.meta_title = 'عنوان محركات البحث 160 حرفاً كحد أقصى.';
  values.meta_description = cleanText(body.meta_description, 301);
  if (values.meta_description.length > 300) errors.meta_description = 'وصف محركات البحث 300 حرف كحد أقصى.';
  values.status = body.status === 'published' ? 'published' : 'draft';
  values.needs_review = body.needs_review === '1' || body.needs_review === 'on' ? 1 : 0;
  return { values, errors };
}

function present(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    slug: row.slug,
    title: row.title_ar,
    excerpt: row.excerpt_ar || '',
    body: row.body_ar,
    html: undefined,
    hasCover: Boolean(row.cover_path),
    status: row.status,
    publishedAt: row.published_at,
    metaTitle: row.meta_title || '',
    metaDescription: row.meta_description || '',
    needsReview: Boolean(Number(row.needs_review)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ------------------------------------------------------------ public

const PUBLISHED = "status = 'published' AND published_at IS NOT NULL AND published_at <= ?";

async function listPublished(pool, { page = 1, now = new Date() } = {}) {
  const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM blog_posts WHERE ${PUBLISHED}`, [now]);
  const total = Number(n);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  const [rows] = await pool.query(
    `SELECT ${COLUMNS} FROM blog_posts WHERE ${PUBLISHED} ORDER BY published_at DESC, id DESC LIMIT ${PAGE_SIZE} OFFSET ${(current - 1) * PAGE_SIZE}`,
    [now],
  );
  return { rows: rows.map(present), total, page: current, pages };
}

async function getPublished(pool, slug, now = new Date()) {
  if (!/^[a-z0-9-]{3,100}$/.test(String(slug))) return null;
  const [[row]] = await pool.query(`SELECT ${COLUMNS} FROM blog_posts WHERE slug = ? AND ${PUBLISHED}`, [slug, now]);
  const post = present(row);
  if (post) post.html = markdown.render(post.body);
  return post;
}

async function publishedIndex(pool, now = new Date()) {
  const [rows] = await pool.query(`SELECT slug, updated_at, published_at FROM blog_posts WHERE ${PUBLISHED} ORDER BY published_at DESC LIMIT 2000`, [now]);
  return rows;
}

async function coverFor(pool, slug, now = new Date()) {
  if (!/^[a-z0-9-]{3,100}$/.test(String(slug))) return null;
  const [[row]] = await pool.query(`SELECT cover_path FROM blog_posts WHERE slug = ? AND ${PUBLISHED}`, [slug, now]);
  return row && row.cover_path ? row.cover_path : null;
}

// ------------------------------------------------------------ admin

async function listAll(pool) {
  const [rows] = await pool.query(`SELECT ${COLUMNS} FROM blog_posts ORDER BY id DESC LIMIT 500`);
  return rows.map(present);
}

async function getById(pool, id) {
  if (!/^[1-9]\d{0,17}$/.test(String(id))) return null;
  const [[row]] = await pool.query(`SELECT ${COLUMNS} FROM blog_posts WHERE id = ?`, [id]);
  return present(row);
}

/** Stores a cover image upload. Returns { name } | { error: 'type' | 'size' | 'empty' | 'corrupt' }. */
async function storeCover(file) {
  const result = await images.processImage(file.data, { truncated: Boolean(file.truncated) });
  if (!result.ok) return { error: result.error };
  const saved = await images.saveImage(result.buffer);
  return { name: saved.name };
}

/** A DATETIME rounds fractions up, which could put "now" a moment in the future: whole seconds only. */
const wholeSeconds = (at) => new Date(Math.floor(at.getTime() / 1000) * 1000);

async function create(pool, values, coverName, now = new Date()) {
  const [result] = await pool.query(
    `INSERT INTO blog_posts (slug, title_ar, excerpt_ar, body_ar, cover_path, status, published_at, meta_title, meta_description, needs_review)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      values.slug, values.title_ar, values.excerpt_ar || null, values.body_ar, coverName || null, values.status,
      values.status === 'published' ? wholeSeconds(now) : null, values.meta_title || null, values.meta_description || null, values.needs_review,
    ],
  );
  return result.insertId;
}

/** Saves a post. coverName: a new file (replaces the old one), null = keep, false = remove. */
async function update(pool, id, values, coverName, now = new Date()) {
  const [[old]] = await pool.query('SELECT cover_path FROM blog_posts WHERE id = ?', [id]);
  if (!old) return false;
  const cover = coverName === null ? old.cover_path : coverName === false ? null : coverName;
  await pool.query(
    `UPDATE blog_posts SET title_ar = ?, excerpt_ar = ?, body_ar = ?, cover_path = ?, status = ?,
            published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, ?) ELSE published_at END,
            meta_title = ?, meta_description = ?, needs_review = ? WHERE id = ?`,
    [values.title_ar, values.excerpt_ar || null, values.body_ar, cover, values.status, values.status, wholeSeconds(now), values.meta_title || null, values.meta_description || null, values.needs_review, id],
  );
  if (old.cover_path && old.cover_path !== cover) await images.deleteImage(old.cover_path).catch(() => {});
  return true;
}

async function remove(pool, id) {
  const [[row]] = await pool.query('SELECT cover_path FROM blog_posts WHERE id = ?', [id]);
  if (!row) return false;
  await pool.query('DELETE FROM blog_posts WHERE id = ?', [id]);
  if (row.cover_path) await images.deleteImage(row.cover_path).catch(() => {});
  return true;
}

module.exports = { PAGE_SIZE, validatePost, present, listPublished, getPublished, publishedIndex, coverFor, listAll, getById, storeCover, create, update, remove };
