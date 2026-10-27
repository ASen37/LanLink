'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_PIECE = 4 * 1024 * 1024;
const MIN_PIECE = 64 * 1024;

function sha256(...parts) {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

function randHex(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

function pieceSizeFor(size) {
  if (size <= 1 << 20) return MIN_PIECE;
  if (size <= 8 << 20) return 256 * 1024;
  if (size <= 128 << 20) return 1 << 20;
  if (size <= 1 << 30) return 2 << 20;
  return MAX_PIECE;
}

async function hashFileChunks(file, pieceSize, onProgress, signal) {
  const stat = await fsp.stat(file);
  const size = stat.size;
  const fh = await fsp.open(file, 'r');
  const chunks = [];
  const tree = crypto.createHash('sha256');
  const buf = Buffer.allocUnsafe(pieceSize);
  let offset = 0;
  try {
    let n = 0;
    while (offset < size) {
      if (signal && signal.aborted) throw new Error('aborted');
      const len = Math.min(pieceSize, size - offset);
      const { bytesRead } = await fh.read(buf, 0, len, offset);
      if (bytesRead !== len) throw new Error(`short read in ${file}`);
      const digest = crypto.createHash('sha256').update(buf.subarray(0, len)).digest();
      chunks.push(digest.toString('hex'));
      tree.update(digest);
      offset += len;
      if (onProgress) onProgress(offset);
      if (++n % 32 === 0) await new Promise((r) => setImmediate(r));
    }
  } finally {
    await fh.close();
  }
  return { size, pieceSize, chunks, treeHash: tree.digest('hex'), mtimeMs: Math.round(stat.mtimeMs) };
}

const IGNORED_NAMES = new Set([
  'desktop.ini',
  'thumbs.db',
  '.ds_store',
  '$recycle.bin',
  'system volume information',
  '.lanlink-archive'
]);

function isIgnoredName(name) {
  const lower = name.toLowerCase();
  if (IGNORED_NAMES.has(lower)) return true;
  if (lower.endsWith('.lanlink-part') || lower.endsWith('.lanlink-part.json')) return true;
  return false;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function sanitizeSegment(segment, fallback = '_') {
  let s = String(segment).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+$/g, '').replace(/^\.+$/, '_');
  s = s.replace(/[. ]+$/g, '');
  if (!s) s = fallback;
  if (WINDOWS_RESERVED.test(s.split('.')[0])) s = `_${s}`;
  if (s.length > 180) {
    const ext = path.extname(s).slice(0, 20);
    s = s.slice(0, 180 - ext.length) + ext;
  }
  return s;
}

function splitRel(relPath) {
  return String(relPath).replace(/\\/g, '/').split('/').filter(Boolean);
}

function safeJoin(root, relPath) {
  const segs = splitRel(relPath).map((s) => sanitizeSegment(s));
  const target = path.resolve(root, ...segs);
  const rootResolved = path.resolve(root);
  if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
    throw new Error('path escapes destination');
  }
  return target;
}

async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

function timestampSlug(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

async function walkPaths(inputs, onProgress) {
  const entries = [];
  const seen = new Set();
  let scanned = 0;

  async function addFile(absPath, relPath) {
    if (seen.has(relPath)) return;
    seen.add(relPath);
    const stat = await fsp.stat(absPath);
    entries.push({ path: relPath, absPath, type: 'file', size: stat.size, mtimeMs: Math.round(stat.mtimeMs) });
    scanned += stat.size;
    if (onProgress) onProgress(scanned);
  }

  async function addDir(absPath, relPath) {
    if (seen.has(relPath + '/')) return;
    seen.add(relPath + '/');
    entries.push({ path: relPath.replace(/\/+$/, '') + '/', absPath, type: 'dir' });
    let items;
    try {
      items = await fsp.readdir(absPath, { withFileTypes: true });
    } catch {
      return;
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      if (isIgnoredName(item.name)) continue;
      const childAbs = path.join(absPath, item.name);
      const childRel = relPath ? `${relPath.replace(/\/+$/, '')}/${item.name}` : item.name;
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) await addDir(childAbs, childRel);
      else if (item.isFile()) await addFile(childAbs, childRel);
    }
  }

  for (const input of inputs) {
    const abs = path.resolve(input);
    const stat = await fsp.stat(abs);
    const base = path.basename(abs);
    if (stat.isDirectory()) {
      await addDir(abs, base);
    } else if (stat.isFile()) {
      await addFile(abs, base);
    }
  }
  return entries;
}

async function freeSpace(dir) {
  try {
    const s = await fsp.statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

module.exports = {
  sha256,
  randHex,
  pieceSizeFor,
  hashFileChunks,
  isIgnoredName,
  sanitizeSegment,
  safeJoin,
  pathExists,
  timestampSlug,
  walkPaths,
  freeSpace,
  formatBytes,
  MIN_PIECE,
  MAX_PIECE
};
