'use strict';

// Listing photos (rows of unit_photos). Each upload is checked by its first
// bytes, re-encoded by sharp to JPEG (at most 1600 px, no EXIF or other
// metadata) and given a 480 px thumbnail; both files get random names in
// UPLOAD_DIR, outside the web root. A listing keeps at most MAX_PHOTOS photos.
// Public visitors get a photo only while its listing is published (see
// photoForPublic); the office can always see its own (photoForOffice).

const rules = require('../config/listings');
const images = require('./images');
const { PUBLIC_WHERE } = require('./listings');
const { scopeToOffice } = require('./scopeToOffice');
const { withTransaction } = require('./transaction');
const { createAudit } = require('./audit');

const ERROR_MESSAGES = {
  type: 'نوع الملف غير مدعوم. أرسل صورة JPG أو PNG أو WebP.',
  size: 'حجم الصورة أكبر من 5 ميجابايت.',
  empty: 'الملف فارغ.',
  corrupt: 'تعذّرت قراءة الصورة. جرّب صورة أخرى.',
  over: `الحد الأقصى ${rules.MAX_PHOTOS} صور للإعلان الواحد.`,
};

async function removeFiles(names) {
  for (const name of names) {
    if (name) await images.deleteImage(name).catch(() => {});
  }
}

/** The photos of a listing, cover and order first. */
async function photosFor(pool, officeId, unitId) {
  const scoped = scopeToOffice(pool, officeId);
  const rows = await scoped.query(
    `SELECT p.id, p.is_cover, p.sort_order, p.size_bytes FROM unit_photos p JOIN units u ON u.id = p.unit_id
      WHERE p.unit_id = ? AND u.office_id = :office_id ORDER BY p.is_cover DESC, p.sort_order ASC, p.id ASC`,
    [unitId],
  );
  return rows.map((r) => ({ id: Number(r.id), isCover: Boolean(Number(r.is_cover)), sortOrder: Number(r.sort_order), size: r.size_bytes === null ? null : Number(r.size_bytes) }));
}

/**
 * Adds uploaded files (each { data, truncated }) to a listing. Files over the
 * limit are dropped; bad files are reported by code. Returns
 * { ok, added, errors: [code] } or { ok: false, error: 'not_found' | 'rented' }.
 */
async function addPhotos(pool, { officeId, listingId, files, actorId, ip }) {
  const processed = [];
  const errors = [];
  try {
    for (const file of files.slice(0, rules.MAX_PHOTOS + 1)) {
      const result = await images.processImage(file.data, { truncated: Boolean(file.truncated) });
      if (!result.ok) {
        errors.push(result.error);
        continue;
      }
      const full = await images.saveImage(result.buffer);
      let thumb;
      try {
        thumb = await images.saveImage(await images.makeThumbnail(result.buffer, rules.THUMB_SIDE));
      } catch (err) {
        await removeFiles([full.name]);
        throw err;
      }
      processed.push({ full, thumb });
    }

    const outcome = await withTransaction(pool, async (conn) => {
      const scoped = scopeToOffice(conn, officeId);
      const [listing] = await scoped.query('SELECT id, unit_id, status FROM listings WHERE id = ? AND office_id = :office_id FOR UPDATE', [listingId]);
      if (!listing) return { ok: false, error: 'not_found' };
      if (listing.status === 'rented') return { ok: false, error: 'rented' };
      const [{ n, top }] = await scoped.query(
        `SELECT COUNT(*) AS n, COALESCE(MAX(p.sort_order), 0) AS top FROM unit_photos p JOIN units u ON u.id = p.unit_id
          WHERE p.unit_id = ? AND u.office_id = :office_id`,
        [listing.unit_id],
      );
      const room = Math.max(0, rules.MAX_PHOTOS - Number(n));
      const keep = processed.slice(0, room);
      let order = Number(top);
      for (const [i, photo] of keep.entries()) {
        order += 1;
        await scoped.insert('unit_photos', {
          unit_id: listing.unit_id, path: photo.full.name, thumb_path: photo.thumb.name, size_bytes: photo.full.size,
          sort_order: order, is_cover: Number(n) === 0 && i === 0 ? 1 : 0,
        });
      }
      if (keep.length) await createAudit(conn).write(actorId, officeId, 'listing.photos_add', 'listing', Number(listingId), null, { count: keep.length }, ip);
      return { ok: true, keep: keep.length, dropped: processed.slice(room) };
    });

    if (!outcome.ok) {
      await removeFiles(processed.flatMap((p) => [p.full.name, p.thumb.name]));
      return outcome;
    }
    await removeFiles(outcome.dropped.flatMap((p) => [p.full.name, p.thumb.name]));
    if (outcome.dropped.length || files.length > rules.MAX_PHOTOS) errors.push('over');
    return { ok: true, added: outcome.keep, errors };
  } catch (err) {
    await removeFiles(processed.flatMap((p) => [p.full.name, p.thumb.name]));
    throw err;
  }
}

/** Makes one photo the cover. */
async function setCover(pool, { officeId, unitId, photoId }) {
  const scoped = scopeToOffice(pool, officeId);
  const [photo] = await scoped.query(
    'SELECT p.id FROM unit_photos p JOIN units u ON u.id = p.unit_id WHERE p.id = ? AND p.unit_id = ? AND u.office_id = :office_id',
    [photoId, unitId],
  );
  if (!photo) return false;
  await scoped.query('UPDATE unit_photos SET is_cover = (id = ?) WHERE unit_id = ? AND unit_id IN (SELECT id FROM units WHERE office_id = :office_id)', [photoId, unitId]);
  return true;
}

/** Moves a photo one place earlier ('up') or later ('down'). */
async function move(pool, { officeId, unitId, photoId, direction }) {
  const list = await photosFor(pool, officeId, unitId);
  const at = list.findIndex((p) => p.id === Number(photoId));
  if (at < 0) return false;
  const other = direction === 'up' ? at - 1 : at + 1;
  if (other < 0 || other >= list.length) return true;
  [list[at], list[other]] = [list[other], list[at]];
  const scoped = scopeToOffice(pool, officeId);
  for (const [i, photo] of list.entries()) {
    await scoped.query('UPDATE unit_photos SET sort_order = ? WHERE id = ? AND unit_id IN (SELECT id FROM units WHERE office_id = :office_id)', [i + 1, photo.id]);
  }
  return true;
}

/** Deletes one photo (row and both files). The cover passes to the next photo. */
async function removePhoto(pool, { officeId, unitId, photoId, actorId, ip }) {
  const names = await withTransaction(pool, async (conn) => {
    const scoped = scopeToOffice(conn, officeId);
    const [photo] = await scoped.query(
      `SELECT p.id, p.path, p.thumb_path, p.is_cover FROM unit_photos p JOIN units u ON u.id = p.unit_id
        WHERE p.id = ? AND p.unit_id = ? AND u.office_id = :office_id FOR UPDATE`,
      [photoId, unitId],
    );
    if (!photo) return null;
    await scoped.query('DELETE FROM unit_photos WHERE id = ? AND unit_id IN (SELECT id FROM units WHERE office_id = :office_id)', [photoId]);
    if (Number(photo.is_cover)) {
      await scoped.query(
        `UPDATE unit_photos SET is_cover = 1 WHERE unit_id = ? AND unit_id IN (SELECT id FROM units WHERE office_id = :office_id)
          ORDER BY sort_order ASC, id ASC LIMIT 1`,
        [unitId],
      );
    }
    await createAudit(conn).write(actorId, officeId, 'listing.photo_delete', 'unit', Number(unitId), null, null, ip);
    return [photo.path, photo.thumb_path];
  });
  if (!names) return false;
  await removeFiles(names);
  return true;
}

/** File names of a photo for the public: only while its listing is public. Returns { name, updatedAt } or null. */
async function photoForPublic(pool, photoId, variant, now = new Date()) {
  if (!/^[1-9]\d{0,17}$/.test(String(photoId))) return null;
  const [[row]] = await pool.query(
    `SELECT p.path, p.thumb_path, p.updated_at FROM unit_photos p
       JOIN listings l ON l.unit_id = p.unit_id JOIN offices o ON o.id = l.office_id
      WHERE p.id = ? AND ${PUBLIC_WHERE}`,
    [photoId, now, now],
  );
  if (!row) return null;
  return { name: variant === 'thumb' && row.thumb_path ? row.thumb_path : row.path, updatedAt: row.updated_at };
}

/** File name of one of the office's own photos (draft or not). */
async function photoForOffice(pool, officeId, photoId, variant) {
  if (!/^[1-9]\d{0,17}$/.test(String(photoId))) return null;
  const scoped = scopeToOffice(pool, officeId);
  const [row] = await scoped.query(
    'SELECT p.path, p.thumb_path FROM unit_photos p JOIN units u ON u.id = p.unit_id WHERE p.id = ? AND u.office_id = :office_id',
    [photoId],
  );
  if (!row) return null;
  return { name: variant === 'thumb' && row.thumb_path ? row.thumb_path : row.path };
}

module.exports = { ERROR_MESSAGES, removeFiles, photosFor, addPhotos, setCover, move, removePhoto, photoForPublic, photoForOffice };
