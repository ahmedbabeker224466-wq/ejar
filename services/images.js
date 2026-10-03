'use strict';

// Photo storage for maintenance requests.
// - The type comes from the file's first bytes (JPEG, PNG, WebP), never from
//   its name or the browser's claim.
// - Every image is decoded and re-encoded as JPEG with sharp: at most 1600 px,
//   orientation applied, and no metadata at all (EXIF, GPS, camera, comments
//   are dropped because sharp writes none unless asked).
// - Files live in UPLOAD_DIR (default <project>/storage/uploads), which must be
//   outside the public folder; the name is random, never the uploaded name.
// - They are served only by an authenticated route that checks ownership.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 3;
const MAX_SIDE = 1600;
const MAX_INPUT_PIXELS = 40 * 1000 * 1000;
const NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/;
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

/** 'jpeg' | 'png' | 'webp' from the first bytes, or null. */
function sniffImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

/** The uploads directory. Throws when it would sit inside the public folder. */
function uploadDir(env = process.env) {
  const dir = path.resolve(env.UPLOAD_DIR || path.join(__dirname, '..', 'storage', 'uploads'));
  if (dir === PUBLIC_DIR || dir.startsWith(PUBLIC_DIR + path.sep)) {
    throw new Error('UPLOAD_DIR must be outside the public folder');
  }
  return dir;
}

/**
 * Checks and re-encodes one uploaded image. Returns { ok, buffer } or
 * { ok: false, error } with error 'type' | 'size' | 'empty' | 'corrupt'.
 */
async function processImage(buffer, { truncated = false } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return { ok: false, error: 'empty' };
  if (truncated || buffer.length > MAX_BYTES) return { ok: false, error: 'size' };
  if (!sniffImage(buffer)) return { ok: false, error: 'type' };
  try {
    const out = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
      .rotate()
      .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
    return { ok: true, buffer: out };
  } catch {
    return { ok: false, error: 'corrupt' };
  }
}

/** Writes a processed image under a random name. Returns { name, size }. */
async function saveImage(buffer, env = process.env) {
  const dir = uploadDir(env);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const name = `${crypto.randomUUID()}.jpg`;
  await fs.promises.writeFile(path.join(dir, name), buffer, { mode: 0o600, flag: 'wx' });
  return { name, size: buffer.length };
}

/** Absolute path of a stored image, or null for a name that is not one of ours. */
function imagePath(name, env = process.env) {
  return NAME.test(String(name)) ? path.join(uploadDir(env), name) : null;
}

async function deleteImage(name, env = process.env) {
  const file = imagePath(name, env);
  if (file) await fs.promises.rm(file, { force: true });
}

module.exports = { MAX_BYTES, MAX_FILES, MAX_SIDE, sniffImage, uploadDir, processImage, saveImage, imagePath, deleteImage };
