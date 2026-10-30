'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const crypto = require('node:crypto');

const {
  safeJoin,
  sanitizeSegment,
  randHex,
  freeSpace,
  pathExists
} = require('./util');
const { archiveExisting } = require('./transfer');

const CHUNK = 4 * 1024 * 1024;
const INBOX_NAME = '访客上传';
const GUEST_COOKIE = 'lanlink_guest';
const SESSION_TTL = 12 * 3600 * 1000;
const LOGIN_WINDOW = 60 * 1000;
const LOGIN_LIMIT = 20;
const LOGIN_BLOCK = 5 * 60 * 1000;
const MAX_FILES = 20000;
const MAX_BATCHES_PER_IP = 3;
const MAX_BATCHES = 12;
const IDLE_MS = 10 * 60 * 1000;
const ARCHIVE_NAME = '.lanlink-archive';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip'
};

// 访客页只暴露这些静态资源，路径必须显式登记，避免把服务端目录整体暴露出去
const GUEST_ASSETS = new Map([
  ['/guest/guest.css', 'guest.css'],
  ['/guest/guest.js', 'guest.js'],
  ['/guest/theme.css', 'theme.css'],
  ['/guest/theme.js', 'theme.js'],
  ['/guest/vendor/fonts.css', 'vendor/fonts.css'],
  ['/guest/vendor/wordmark.css', 'vendor/wordmark.css'],
  ['/guest/vendor/nes.min.css', 'vendor/nes.min.css'],
  ['/guest/vendor/fusion-pixel-12px.woff2', 'vendor/fusion-pixel-12px.woff2'],
  ['/guest/favicon.png', 'favicon.png']
]);

const PAGE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Resource-Policy': 'same-origin'
};

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders
  });
  res.end(body);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function readJson(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求内容过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('请求格式错误'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('分块数据过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function normalizeRel(raw) {
  if (typeof raw !== 'string') throw Object.assign(new Error('文件路径无效'), { status: 400 });
  const cleaned = raw.replace(/\\/g, '/').replace(/^\/+/, '');
  const segs = cleaned.split('/').filter((s) => s && s !== '.');
  if (!segs.length) throw Object.assign(new Error('文件路径为空'), { status: 400 });
  if (segs.length > 32) throw Object.assign(new Error('目录层级过深'), { status: 400 });
  if (segs.some((s) => s === '..')) throw Object.assign(new Error('文件路径无效'), { status: 400 });
  if (cleaned.length > 512) throw Object.assign(new Error('文件路径过长'), { status: 400 });
  if (segs[0].toLowerCase() === ARCHIVE_NAME) throw Object.assign(new Error('文件路径无效'), { status: 400 });
  const lower = segs[segs.length - 1].toLowerCase();
  if (lower.endsWith('.lanlink-part') || lower.endsWith('.lanlink-part.json')) {
    throw Object.assign(new Error('文件路径无效'), { status: 400 });
  }
  return segs.join('/');
}

function sanitizeLabel(raw, fallback) {
  const text = String(raw || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
  return text || fallback;
}

function chunkCountFor(size) {
  return Math.ceil(size / CHUNK);
}

function chunkLengthFor(size, idx) {
  const offset = idx * CHUNK;
  return Math.max(0, Math.min(CHUNK, size - offset));
}

function contentDisposition(name) {
  const fallback = String(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function lanUrls(port, token) {
  if (!port) return [];
  const found = [];
  let interfaces;
  try {
    interfaces = os.networkInterfaces();
  } catch {
    interfaces = {};
  }
  for (const [name, list] of Object.entries(interfaces)) {
    for (const item of list || []) {
      const family = typeof item.family === 'string' ? item.family : item.family === 4 ? 'IPv4' : '';
      if (family !== 'IPv4' || item.internal) continue;
      if (item.address === '0.0.0.0' || item.address.startsWith('169.254.')) continue;
      // 主链接优先级：192.168.* > 10.* / 172.16-31.* > 其他，
      // 同一档里虚拟网卡再降权，保证复制出去的是最常见的那条局域网地址。
      let score = 1;
      if (item.address.startsWith('192.168.')) score = 6;
      else if (item.address.startsWith('10.')) score = 4;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(item.address)) score = 4;
      if (/vEthernet|VirtualBox|VMware|Docker|WSL|Loopback|Tailscale|ZeroTier/i.test(name)) score -= 3;
      found.push({ url: `http://${item.address}:${port}/u/${token}`, address: item.address, score });
    }
  }
  found.sort((a, b) => b.score - a.score || a.address.localeCompare(b.address, undefined, { numeric: true }));
  const seen = new Set();
  const urls = [];
  for (const item of found) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    urls.push(item.url);
  }
  if (!urls.length) urls.push(`http://127.0.0.1:${port}/u/${token}`);
  return urls;
}

class GuestServer {
  constructor({ manager, uiDir, onLog } = {}) {
    this.manager = manager;
    this.uiDir = uiDir || path.join(__dirname, '..', 'ui');
    this.onLog = onLog;
    this.server = null;
    this.port = 0;
    this.requestedPort = null;
    this.listening = false;
    this.lastError = null;
    this.sessions = new Map();
    this.loginRates = new Map();
    this.batches = new Map();
    this.activePaths = new Map();
    this.tickTimer = null;
    this.cleanupTimer = null;
    this.lastCleanup = 0;
    this.closed = false;
  }

  get settings() {
    return this.manager.settings;
  }

  get inboxRoot() {
    return path.join(this.settings.downloadDir, INBOX_NAME);
  }

  async start(port) {
    if (this.listening && this.requestedPort === port) return this.port;
    await this.stop();
    this.closed = false;
    this.sessions.clear();
    this.requestedPort = port;
    const requested = Number(port);
    let lastErr = null;
    for (let attempt = 0; attempt <= 10; attempt++) {
      const candidate = Number.isFinite(requested) && requested > 0 ? requested + attempt : 0;
      try {
        await this.listen(candidate);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (err.code !== 'EADDRINUSE' || attempt === 10) break;
      }
    }
    if (lastErr) {
      this.lastError = lastErr.code === 'EADDRINUSE'
        ? `端口 ${requested} 已被占用`
        : `访客端口启动失败：${lastErr.message}`;
      throw lastErr;
    }
    this.lastError = null;
    this.tickTimer = setInterval(() => this.tick(Date.now()), 5000);
    this.tickTimer.unref?.();
    this.cleanupTimer = setInterval(() => {
      this.cleanupStaleParts().catch(() => {});
    }, 6 * 3600 * 1000);
    this.cleanupTimer.unref?.();
    this.cleanupStaleParts().catch(() => {});
    return this.port;
  }

  listen(port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handle(req, res).catch((err) => {
          this.onLog?.(`guest request error: ${err.stack || err.message}`);
          if (!res.headersSent) {
            sendJson(res, err.status || 500, { error: err.message || '服务器错误' });
          } else {
            try { res.destroy(); } catch { /* noop */ }
          }
        });
      });
      server.requestTimeout = 15 * 60 * 1000;
      server.headersTimeout = 60 * 1000;
      server.keepAliveTimeout = 75 * 1000;
      const onError = (err) => {
        server.off('listening', onListening);
        server.close(() => {});
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        this.server = server;
        this.port = server.address().port;
        this.listening = true;
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '0.0.0.0');
    });
  }

  async stop() {
    this.closed = true;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    const active = [];
    for (const batch of this.batches.values()) {
      if (batch.status === 'uploading') {
        batch.canceled = true;
        batch.status = 'canceled';
        batch.transfer.error = '访客上传已中断';
        active.push(batch);
        for (const state of batch.files) this.activePaths.delete(state.finalPath);
      }
      this.clearTimers(batch);
    }
    await this.flushAllSidecars();
    for (const batch of active) {
      this.manager.completeTransfer(batch.transfer, 'canceled', '访客上传已中断');
    }
    this.batches.clear();
    this.activePaths.clear();
    this.sessions.clear();
    this.loginRates.clear();
    this.listening = false;
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise((resolve) => {
      server.close(() => resolve());
      const timer = setTimeout(resolve, 1500);
      timer.unref?.();
    });
  }

  urls() {
    if (!this.listening) return [];
    return lanUrls(this.port, this.settings.guestToken);
  }

  clearSessions() {
    this.sessions.clear();
  }

  revokeAll(reason = '访客访问已更新') {
    this.sessions.clear();
    for (const batch of [...this.batches.values()]) {
      if (batch.status === 'uploading') this.abortBatch(batch, 'canceled', reason).catch(() => {});
    }
  }

  publicInfo() {
    const s = this.settings;
    return {
      enabled: Boolean(s.guestEnabled),
      running: this.listening,
      port: this.listening ? this.port : Number(s.guestPort) || 0,
      urls: this.urls(),
      code: s.guestCode || '',
      expiresAt: s.guestExpiresAt || 0,
      maxFileBytes: (s.guestMaxFileMB || 0) * 1024 * 1024,
      maxBatchBytes: (s.guestMaxBatchMB || 0) * 1024 * 1024,
      inbox: this.inboxRoot,
      error: this.lastError || null
    };
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://lanlink.local');
    const pathname = decodeURIComponent(url.pathname);

    if (req.method === 'GET' && pathname === '/favicon.ico') {
      res.writeHead(204, { 'Cache-Control': 'public, max-age=86400' });
      res.end();
      return;
    }

    const asset = this.assetPath(pathname);
    if (asset) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' });
        res.end();
        return;
      }
      return this.serveAsset(req, res, asset);
    }

    const match = pathname.match(/^\/u\/([0-9a-f]{32})(\/.*)?$/);
    if (!match) {
      return sendText(res, 404, '邀请链接无效或已失效');
    }
    const token = match[1];
    if (!safeEqual(token, this.settings.guestToken || '')) {
      return sendText(res, 404, '邀请链接无效或已失效');
    }

    const origin = req.headers.origin;
    if (origin) {
      let originHost = '';
      try { originHost = new URL(origin).host; } catch { /* invalid */ }
      if (originHost !== req.headers.host) {
        return sendJson(res, 403, { error: '来源不受信任' });
      }
    }

    const rest = match[2] || '/';
    if (rest === '/' || rest === '') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' });
        res.end();
        return;
      }
      return this.serveGuestPage(req, res);
    }

    if (!rest.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });
    const api = rest.slice('/api'.length);
    const ip = this.clientIp(req);

    if (req.method === 'POST' && api === '/login') {
      return this.handleLogin(req, res, ip, token);
    }
    if (req.method === 'POST' && api === '/logout') {
      const cookies = parseCookies(req.headers.cookie);
      if (cookies[GUEST_COOKIE]) this.sessions.delete(cookies[GUEST_COOKIE]);
      const expire = `${GUEST_COOKIE}=; Path=/u/${token}; HttpOnly; SameSite=Strict; Max-Age=0`;
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': expire });
    }

    const expiresAt = this.settings.guestExpiresAt || 0;
    const openAccess = this.settings.requireCode === false && (!expiresAt || Date.now() <= expiresAt);
    const session = this.auth(req, token) || (openAccess ? { ip, open: true } : null);
    if (!session) {
      return sendJson(res, 401, { error: '请先输入访问码', auth: true });
    }

    if (req.method === 'GET' && api === '/share') {
      return this.sendShareInfo(res);
    }
    if (req.method === 'GET' && api === '/share/list') {
      return this.sendShareList(res, url.searchParams.get('path'));
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && api === '/share/file') {
      return this.sendShareFile(req, res, url.searchParams.get('path'));
    }
    if (req.method === 'GET' && api === '/info') {
      return sendJson(res, 200, {
        deviceName: this.manager.identity?.name || 'LanLink',
        chunkSize: CHUNK,
        maxFileBytes: (this.settings.guestMaxFileMB || 0) * 1024 * 1024,
        maxBatchBytes: (this.settings.guestMaxBatchMB || 0) * 1024 * 1024,
        expiresAt: this.settings.guestExpiresAt || 0,
        inboxLabel: INBOX_NAME,
        shareName: this.shareRoot() ? path.basename(this.shareRoot()) : '',
        requireCode: this.settings.requireCode !== false,
        shareKind: this.shareKind(),
        serverTime: Date.now()
      });
    }
    if (req.method === 'POST' && api === '/batches') {
      const body = await readJson(req);
      return this.createBatch(req, res, ip, body);
    }

    const fileFinish = api.match(/^\/batches\/([0-9a-f]{8,32})\/files\/([0-9]+)\/finish$/);
    if (req.method === 'POST' && fileFinish) {
      return this.finishFile(res, fileFinish[1], Number(fileFinish[2]));
    }
    const chunkPut = api.match(/^\/batches\/([0-9a-f]{8,32})\/files\/([0-9]+)\/chunks\/([0-9]+)$/);
    if (req.method === 'PUT' && chunkPut) {
      return this.putChunk(req, res, chunkPut[1], Number(chunkPut[2]), Number(chunkPut[3]));
    }
    const batchFinish = api.match(/^\/batches\/([0-9a-f]{8,32})\/finish$/);
    if (req.method === 'POST' && batchFinish) {
      return this.finishBatch(res, batchFinish[1]);
    }
    const batchCancel = api.match(/^\/batches\/([0-9a-f]{8,32})\/cancel$/);
    if (req.method === 'POST' && batchCancel) {
      return this.clientCancel(res, batchCancel[1]);
    }
    const batchStatus = api.match(/^\/batches\/([0-9a-f]{8,32})$/);
    if (req.method === 'GET' && batchStatus) {
      return this.batchStatus(res, batchStatus[1]);
    }

    return sendJson(res, 404, { error: 'not found' });
  }

  clientIp(req) {
    const raw = req.socket?.remoteAddress || '';
    return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
  }

  assetPath(pathname) {
    return GUEST_ASSETS.get(pathname) || null;
  }

  async serveAsset(req, res, name) {
    const file = path.join(this.uiDir, name);
    try {
      const stat = await fsp.stat(file);
      if (!stat.isFile()) throw new Error('not a file');
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'no-cache',
        ...PAGE_HEADERS
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    } catch {
      sendText(res, 404, 'Not found');
    }
  }

  async serveGuestPage(req, res) {
    const file = path.join(this.uiDir, 'guest.html');
    try {
      const stat = await fsp.stat(file);
      if (!stat.isFile()) throw new Error('not a file');
      res.writeHead(200, {
        'Content-Type': MIME['.html'],
        'Content-Length': stat.size,
        'Cache-Control': 'no-store',
        ...PAGE_HEADERS
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    } catch (err) {
      this.onLog?.(`guest page missing: ${err.message}`);
      sendText(res, 500, '访客页面未就绪');
    }
  }

  // 共享目录（只读）：所有下载都限制在这个根目录内
  shareRoot() {
    const raw = typeof this.settings.guestShareDir === 'string' ? this.settings.guestShareDir.trim() : '';
    if (!raw || !path.isAbsolute(raw)) return '';
    try {
      const real = fs.realpathSync(raw);
      const st = fs.statSync(real);
      return st.isDirectory() || st.isFile() ? real : '';
    } catch {
      return '';
    }
  }

  shareKind() {
    const root = this.shareRoot();
    if (!root) return '';
    try {
      return fs.statSync(root).isDirectory() ? 'dir' : 'file';
    } catch {
      return '';
    }
  }

  resolveSharePath(rel) {
    const root = this.shareRoot();
    if (!root) return null;
    const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (clean.includes('\0')) return null;
    const rootStat = fs.statSync(root);
    if (rootStat.isFile()) {
      if (clean && clean !== path.basename(root)) return null;
      return root;
    }
    if (clean.split('/').some((part) => part.startsWith('.'))) return null;
    const abs = path.resolve(root, clean);
    const inside = path.relative(root, abs);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
      if (inside !== '') return null;
    }
    try {
      const real = fs.realpathSync(abs);
      const relReal = path.relative(root, real);
      if (relReal.startsWith('..') || path.isAbsolute(relReal)) return null;
      return real;
    } catch {
      return null;
    }
  }

  sendShareInfo(res) {
    const root = this.shareRoot();
    return sendJson(res, 200, {
      enabled: Boolean(root),
      name: root ? path.basename(root) : '',
      kind: this.shareKind()
    });
  }

  async sendShareList(res, rel) {
    const root = this.shareRoot();
    if (!root) return sendJson(res, 404, { error: '主机未开启文件下载' });
    const abs = this.resolveSharePath(rel);
    if (!abs) return sendJson(res, 403, { error: '路径不可访问' });
    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat) return sendJson(res, 404, { error: '路径不存在' });
    if (stat.isFile()) {
      return sendJson(res, 200, {
        root: path.basename(root),
        kind: 'file',
        path: '',
        parent: '',
        entries: [{
          name: path.basename(abs),
          dir: false,
          size: stat.size,
          mtime: stat.mtimeMs,
          path: ''
        }]
      });
    }
    if (!stat.isDirectory()) return sendJson(res, 404, { error: '目录不存在' });

    const entries = [];
    const items = await fsp.readdir(abs, { withFileTypes: true }).catch(() => []);
    for (const item of items) {
      if (item.name.startsWith('.')) continue;
      const full = path.join(abs, item.name);
      const info = await fsp.lstat(full).catch(() => null);
      if (!info || info.isSymbolicLink()) continue;
      if (!info.isDirectory() && !info.isFile()) continue;
      entries.push({
        name: item.name,
        dir: info.isDirectory(),
        size: info.size,
        mtime: info.mtimeMs,
        path: path.relative(root, full).split(path.sep).join('/')
      });
    }
    entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, 'zh'));
    const current = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const parent = current.includes('/') ? current.slice(0, current.lastIndexOf('/')) : '';
    return sendJson(res, 200, { root: path.basename(root), kind: 'dir', path: current, parent, entries });
  }

  async sendShareFile(req, res, rel) {
    const root = this.shareRoot();
    if (!root) return sendJson(res, 404, { error: '主机未开启文件下载' });
    const abs = this.resolveSharePath(rel);
    if (!abs) return sendJson(res, 403, { error: '路径不可访问' });
    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat || !stat.isFile()) return sendJson(res, 404, { error: '文件不存在' });

    const name = path.basename(abs);
    const headers = {
      'Content-Type': MIME[path.extname(name).toLowerCase()] || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Content-Disposition': contentDisposition(name),
      ...PAGE_HEADERS
    };

    let start = 0;
    let end = stat.size - 1;
    let code = 200;
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
      if (match) {
        if (match[1] === '' && match[2] !== '') {
          start = Math.max(0, stat.size - Number(match[2]));
        } else {
          start = Number(match[1] || 0);
        }
        if (match[2] !== '') end = Math.min(Number(match[2]), stat.size - 1);
        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stat.size) {
          res.writeHead(416, { 'Content-Range': `bytes */${stat.size}`, ...PAGE_HEADERS });
          res.end();
          return;
        }
        code = 206;
        headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
      }
    }

    headers['Content-Length'] = end - start + 1;
    headers.ETag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    res.writeHead(code, headers);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(abs, { start, end, highWaterMark: 1 << 20 });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  handleLogin(req, res, ip, token) {
    const now = Date.now();
    let rate = this.loginRates.get(ip);
    if (!rate || now > rate.resetAt) {
      rate = { count: 0, resetAt: now + LOGIN_WINDOW, blockedUntil: 0 };
      this.loginRates.set(ip, rate);
    }
    if (rate.blockedUntil > now) {
      return sendJson(res, 429, { error: '尝试次数过多，请稍后再试', retryAfter: Math.ceil((rate.blockedUntil - now) / 1000) });
    }
    rate.count += 1;
    if (rate.count > LOGIN_LIMIT) {
      rate.blockedUntil = now + LOGIN_BLOCK;
      return sendJson(res, 429, { error: '尝试次数过多，请稍后再试', retryAfter: Math.ceil(LOGIN_BLOCK / 1000) });
    }

    return readJson(req, 4096).then((body) => {
      const code = typeof body.code === 'string' ? body.code.trim() : '';
      if (this.settings.requireCode !== false && (!/^\d{6}$/.test(code) || !safeEqual(code, this.settings.guestCode || ''))) {
        return sendJson(res, 403, { error: '访问码不正确' });
      }
      const expiresAt = this.settings.guestExpiresAt || 0;
      if (expiresAt && Date.now() > expiresAt) {
        return sendJson(res, 410, { error: '访客链接已过期' });
      }
      rate.count = 0;
      const sid = randHex(24);
      const ttl = expiresAt ? Math.max(1000, Math.min(SESSION_TTL, expiresAt - Date.now())) : SESSION_TTL;
      this.sessions.set(sid, { ip, expiresAt: Date.now() + ttl });
      const cookie = `${GUEST_COOKIE}=${sid}; Path=/u/${token}; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ttl / 1000)}`;
      return sendJson(res, 200, {
        ok: true,
        deviceName: this.manager.identity?.name || 'LanLink',
        expiresAt
      }, { 'Set-Cookie': cookie });
    });
  }

  auth(req, token) {
    const cookies = parseCookies(req.headers.cookie);
    const sid = cookies[GUEST_COOKIE];
    if (!sid) return null;
    const session = this.sessions.get(sid);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(sid);
      return null;
    }
    const expiresAt = this.settings.guestExpiresAt || 0;
    if (expiresAt && Date.now() > expiresAt) return null;
    return session;
  }

  async createBatch(req, res, ip, body) {
    const files = Array.isArray(body.files) ? body.files : null;
    if (!files || files.length < 1 || files.length > MAX_FILES) {
      return sendJson(res, 400, { error: `文件数量需在 1 到 ${MAX_FILES} 之间` });
    }
    const active = [...this.batches.values()].filter((b) => b.status === 'uploading');
    if (active.length >= MAX_BATCHES) {
      return sendJson(res, 429, { error: '主机当前上传任务过多，请稍后再试' });
    }
    if (active.filter((b) => b.ip === ip).length >= MAX_BATCHES_PER_IP) {
      return sendJson(res, 429, { error: '这位访客已有多个上传任务在进行中' });
    }

    const maxFile = Math.max(0, (this.settings.guestMaxFileMB || 0) * 1024 * 1024);
    const maxBatch = Math.max(0, (this.settings.guestMaxBatchMB || 0) * 1024 * 1024);
    const inbox = this.inboxRoot;
    let totalBytes = 0;
    const entries = [];
    const seenTargets = new Set();

    for (const raw of files) {
      if (!raw || typeof raw !== 'object') return sendJson(res, 400, { error: '文件信息无效' });
      let rel;
      try {
        rel = normalizeRel(raw.path);
      } catch (err) {
        return sendJson(res, err.status || 400, { error: err.message });
      }
      const size = Number(raw.size);
      if (!Number.isSafeInteger(size) || size < 0) return sendJson(res, 400, { error: `文件大小无效：${rel}` });
      if (maxFile && size > maxFile) {
        return sendJson(res, 413, { error: `“${path.basename(rel)}”超过单文件上限 ${Math.round(maxFile / 1048576)} MB` });
      }
      let mtimeMs = Number(raw.mtimeMs);
      if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) mtimeMs = 0;
      if (mtimeMs > Date.now() + 86400000) mtimeMs = Date.now();
      const finalPath = safeJoin(inbox, rel);
      if (seenTargets.has(finalPath)) return sendJson(res, 400, { error: `重复的文件路径：${rel}` });
      seenTargets.add(finalPath);
      totalBytes += size;
      if (totalBytes > maxBatch && maxBatch) {
        return sendJson(res, 413, { error: `本批文件总量超过上限 ${Math.round(maxBatch / 1048576)} MB` });
      }
      entries.push({ rel, size, mtimeMs, finalPath });
    }

    for (const entry of entries) {
      if (this.activePaths.has(entry.finalPath)) {
        return sendJson(res, 409, { error: `“${entry.rel}”正在由另一个上传任务处理` });
      }
    }

    const id = randHex(8);
    for (const entry of entries) this.activePaths.set(entry.finalPath, id);
    try {
      await fsp.mkdir(inbox, { recursive: true });
    } catch (err) {
      for (const entry of entries) this.activePaths.delete(entry.finalPath);
      return sendJson(res, 500, { error: `无法创建接收目录：${err.message}` });
    }
    const free = await freeSpace(inbox);
    if (free !== null && free < totalBytes + 64 * 1024 * 1024) {
      for (const entry of entries) this.activePaths.delete(entry.finalPath);
      return sendJson(res, 507, { error: `主机磁盘空间不足，需要约 ${Math.ceil(totalBytes / 1048576)} MB` });
    }

    const tops = new Set(entries.map((e) => e.rel.split('/')[0]));
    const fallback = entries.length === 1
      ? path.basename(entries[0].rel)
      : `访客上传（${entries.length} 个文件）`;
    const label = sanitizeLabel(body.label, tops.size === 1 ? [...tops][0] : fallback);

    const transfer = {
      id,
      direction: 'in',
      peer: { id: `guest-${ip}`, name: '浏览器访客' },
      status: 'transferring',
      rootLabel: label,
      totalBytes,
      totalFiles: entries.length,
      items: entries.map((e) => ({ path: e.rel, type: 'file', size: e.size, mtimeMs: e.mtimeMs })),
      bytes: 0,
      resumedBytes: 0,
      preparedBytes: totalBytes,
      preparedTotal: totalBytes,
      filesDone: 0,
      currentFile: '',
      speed: 0,
      eta: 0,
      error: null,
      startedAt: Date.now(),
      endedAt: 0,
      session: null,
      receiver: null,
      destDir: inbox,
      guest: true,
      guestIp: ip,
      guestBatchId: id
    };

    const batch = {
      id,
      ip,
      userAgent: String(req.headers['user-agent'] || '').slice(0, 200),
      transfer,
      label,
      inbox,
      status: 'uploading',
      canceled: false,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      files: [],
      byRel: new Map(),
      finishing: false,
      cleanupTimer: null
    };

    try {
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const state = {
          id: String(i),
          batch,
          rel: entry.rel,
          size: entry.size,
          mtimeMs: entry.mtimeMs,
          finalPath: entry.finalPath,
          partPath: entry.finalPath + '.lanlink-part',
          sidecarPath: entry.finalPath + '.lanlink-part.json',
          chunks: chunkCountFor(entry.size),
          done: new Set(),
          hashes: {},
          finished: false,
          finishing: null,
          sidecarTimer: null
        };
        batch.files.push(state);
        batch.byRel.set(state.rel, state);
        this.activePaths.set(entry.finalPath, id);
      }
    } catch (err) {
      for (const state of batch.files) this.activePaths.delete(state.finalPath);
      return sendJson(res, 500, { error: err.message });
    }

    this.batches.set(id, batch);
    this.manager.transfers.set(id, transfer);
    this.manager.emitState();
    this.manager.toast(`浏览器访客（${ip}）开始上传“${label}”`, 'info');

    try {
      for (const state of batch.files) {
        await this.prepareFile(state);
        if (batch.canceled) break;
      }
    } catch (err) {
      this.failBatch(batch, `准备接收文件失败：${err.message}`);
      return sendJson(res, 500, { error: err.message });
    }

    if (batch.canceled) {
      return sendJson(res, 409, { error: '上传已取消', status: batch.status });
    }

    const complete = transfer.filesDone >= transfer.totalFiles;
    if (complete) {
      this.completeBatch(batch);
    } else {
      this.manager.emitState();
    }

    return sendJson(res, 200, {
      batch: {
        id,
        label,
        totalBytes,
        totalFiles: entries.length,
        complete
      },
      chunkSize: CHUNK,
      files: batch.files.map((f) => ({
        id: f.id,
        path: f.rel,
        size: f.size,
        chunks: f.chunks,
        done: f.finished ? [] : [...f.done].sort((a, b) => a - b),
        finished: f.finished
      }))
    });
  }

  async prepareFile(state) {
    if (state.finished) return;
    await fsp.mkdir(path.dirname(state.finalPath), { recursive: true });

    let existing = null;
    try {
      existing = await fsp.stat(state.finalPath);
    } catch { /* missing */ }
    if (existing && existing.isFile() && existing.size === state.size && state.mtimeMs
      && Math.abs(existing.mtimeMs - state.mtimeMs) < 2000) {
      state.finished = true;
      const t = state.batch.transfer;
      t.bytes = Math.min(t.totalBytes, t.bytes + state.size);
      t.filesDone += 1;
      this.manager.emitState();
      return;
    }

    let resumed = false;
    try {
      const sidecar = JSON.parse(await fsp.readFile(state.sidecarPath, 'utf8'));
      const age = Date.now() - new Date(sidecar.updatedAt || 0).getTime();
      const ttl = (this.settings.partialTtlHours || 24) * 3600 * 1000;
      const partStat = await fsp.stat(state.partPath);
      const sameFile = sidecar.version === 1
        && sidecar.size === state.size
        && Number(sidecar.mtimeMs) === state.mtimeMs
        && sidecar.chunkSize === CHUNK
        && (ttl <= 0 || age < ttl)
        && partStat.size === state.size;
      if (sameFile) {
        const done = Array.isArray(sidecar.done) ? sidecar.done : [];
        for (const idx of done) {
          if (Number.isInteger(idx) && idx >= 0 && idx < state.chunks) state.done.add(idx);
        }
        if (sidecar.hashes && typeof sidecar.hashes === 'object') {
          for (const [idx, hash] of Object.entries(sidecar.hashes)) {
            const n = Number(idx);
            if (state.done.has(n) && /^[0-9a-f]{64}$/i.test(String(hash))) state.hashes[n] = String(hash);
          }
        }
        resumed = state.done.size > 0;
      } else {
        await fsp.rm(state.partPath, { force: true });
        await fsp.rm(state.sidecarPath, { force: true });
      }
    } catch {
      /* no usable sidecar */
    }

    if (resumed) {
      const t = state.batch.transfer;
      let base = 0;
      for (const idx of state.done) base += chunkLengthFor(state.size, idx);
      t.bytes += base;
      t.resumedBytes += base;
    }

    if (state.chunks === 0 || state.done.size === state.chunks) {
      await this.finalizeFile(state);
      return;
    }

    let handle;
    try {
      handle = await fsp.open(state.partPath, 'r+');
    } catch {
      handle = await fsp.open(state.partPath, 'w+');
    }
    try {
      const stat = await handle.stat();
      if (stat.size !== state.size) await handle.truncate(state.size);
    } finally {
      await handle.close().catch(() => {});
    }
    this.manager.emitState();
  }

  findBatch(res, id) {
    const batch = this.batches.get(id);
    if (!batch) {
      sendJson(res, 404, { error: '上传任务不存在或已结束' });
      return null;
    }
    return batch;
  }

  findFile(res, batch, fileId) {
    const state = batch.files[fileId];
    if (!state) {
      sendJson(res, 404, { error: '文件不存在' });
      return null;
    }
    return state;
  }

  async putChunk(req, res, batchId, fileId, idx) {
    const batch = this.findBatch(res, batchId);
    if (!batch) return;
    if (batch.status !== 'uploading' || batch.canceled) {
      return sendJson(res, 409, { error: '上传已结束', status: batch.status });
    }
    const state = this.findFile(res, batch, fileId);
    if (!state) return;
    if (state.finished) {
      return sendJson(res, 200, { ok: true, idx, received: state.chunks, chunks: state.chunks, already: true });
    }
    if (!Number.isInteger(idx) || idx < 0 || idx >= state.chunks) {
      return sendJson(res, 400, { error: '分块序号无效' });
    }
    const expected = chunkLengthFor(state.size, idx);
    let body;
    try {
      body = await readRaw(req, expected + 1);
    } catch (err) {
      return sendJson(res, err.status || 400, { error: err.message });
    }
    if (batch.canceled || batch.status !== 'uploading') {
      return sendJson(res, 409, { error: '上传已结束', status: batch.status });
    }
    if (body.length !== expected) {
      return sendJson(res, 400, { error: `分块长度不正确（期望 ${expected}，收到 ${body.length}）` });
    }
    batch.lastActivity = Date.now();
    const t = batch.transfer;

    if (state.done.has(idx)) {
      return sendJson(res, 200, { ok: true, idx, received: state.done.size, chunks: state.chunks, duplicate: true });
    }

    const digest = crypto.createHash('sha256').update(body).digest('hex');
    const offset = idx * CHUNK;
    let handle;
    try {
      handle = await fsp.open(state.partPath, 'r+');
    } catch (err) {
      if (err.code === 'ENOENT') {
        try {
          handle = await fsp.open(state.partPath, 'w+');
          await handle.truncate(state.size);
        } catch (openErr) {
          this.failBatch(batch, `无法写入文件：${openErr.message}`);
          return sendJson(res, 507, { error: '主机无法写入文件' });
        }
      } else {
        this.failBatch(batch, `无法写入文件：${err.message}`);
        return sendJson(res, 507, { error: '主机无法写入文件' });
      }
    }
    try {
      await handle.write(body, 0, body.length, offset);
    } catch (err) {
      this.failBatch(batch, `写入磁盘失败：${err.message}`);
      return sendJson(res, 507, { error: `写入磁盘失败：${err.message}` });
    } finally {
      await handle.close().catch(() => {});
    }

    if (batch.canceled) {
      return sendJson(res, 409, { error: '上传已结束', status: batch.status });
    }
    if (state.done.has(idx)) {
      return sendJson(res, 200, { ok: true, idx, received: state.done.size, chunks: state.chunks, duplicate: true });
    }

    state.done.add(idx);
    state.hashes[idx] = digest;
    t.bytes += body.length;
    t.currentFile = state.rel;
    this.scheduleSidecar(state);
    this.manager.emitState();
    return sendJson(res, 200, {
      ok: true,
      idx,
      received: state.done.size,
      chunks: state.chunks,
      sha256: digest
    });
  }

  scheduleSidecar(state) {
    if (state.sidecarTimer || state.finished) return;
    state.sidecarTimer = setTimeout(() => {
      state.sidecarTimer = null;
      this.flushSidecar(state).catch(() => {});
    }, 1200);
    state.sidecarTimer.unref?.();
  }

  async flushSidecar(state) {
    if (state.finished) return;
    const done = [...state.done].sort((a, b) => a - b);
    if (!done.length) return;
    const payload = {
      version: 1,
      size: state.size,
      mtimeMs: state.mtimeMs,
      chunkSize: CHUNK,
      done,
      hashes: state.hashes,
      updatedAt: new Date().toISOString()
    };
    await fsp.mkdir(path.dirname(state.sidecarPath), { recursive: true }).catch(() => {});
    await fsp.writeFile(state.sidecarPath, JSON.stringify(payload)).catch(() => {});
  }

  async flushAllSidecars() {
    const jobs = [];
    for (const batch of this.batches.values()) {
      this.clearFileTimers(batch);
      for (const state of batch.files) {
        if (!state.finished && state.done.size) jobs.push(this.flushSidecar(state));
      }
    }
    await Promise.allSettled(jobs);
  }

  async finishFile(res, batchId, fileId) {
    const batch = this.findBatch(res, batchId);
    if (!batch) return;
    const state = this.findFile(res, batch, fileId);
    if (!state) return;
    if (batch.status !== 'uploading' || batch.canceled) {
      return sendJson(res, 409, { error: '上传已结束', status: batch.status });
    }
    if (state.finished) {
      return sendJson(res, 200, {
        ok: true,
        filesDone: batch.transfer.filesDone,
        totalFiles: batch.transfer.totalFiles,
        complete: batch.status === 'completed'
      });
    }
    if (state.done.size !== state.chunks) {
      const missing = [];
      for (let i = 0; i < state.chunks && missing.length < 20; i++) {
        if (!state.done.has(i)) missing.push(i);
      }
      return sendJson(res, 409, { error: '仍有分块未上传', missing, received: state.done.size, chunks: state.chunks });
    }
    try {
      if (state.finishing) {
        await state.finishing;
      } else {
        state.finishing = this.finalizeFile(state);
        await state.finishing;
      }
    } catch (err) {
      this.failBatch(batch, `保存文件失败：${err.message}`);
    } finally {
      state.finishing = null;
    }
    if (batch.status === 'failed') {
      return sendJson(res, 500, { error: batch.transfer.error || '上传失败' });
    }
    if (batch.status === 'canceled') {
      return sendJson(res, 409, { error: '上传已取消', status: batch.status });
    }
    return sendJson(res, 200, {
      ok: true,
      filesDone: batch.transfer.filesDone,
      totalFiles: batch.transfer.totalFiles,
      complete: batch.status === 'completed'
    });
  }

  async finalizeFile(state) {
    const batch = state.batch;
    if (state.finished) return;
    if (batch.canceled) return;
    const t = batch.transfer;
    if (state.sidecarTimer) {
      clearTimeout(state.sidecarTimer);
      state.sidecarTimer = null;
    }

    const wasEmpty = state.chunks === 0;
    if (!wasEmpty) {
      let handle;
      try {
        handle = await fsp.open(state.partPath, 'r+');
        await handle.sync().catch(() => {});
      } catch (err) {
        throw new Error(`无法打开临时文件：${err.message}`);
      } finally {
        if (handle) await handle.close().catch(() => {});
      }
    } else {
      await fsp.writeFile(state.partPath, Buffer.alloc(0)).catch(() => {});
    }

    let archived = null;
    if (await pathExists(state.finalPath)) {
      archived = await archiveExisting(batch.inbox, state.finalPath, state.rel, this.settings.archiveEnabled !== false);
    }
    try {
      await fsp.rename(state.partPath, state.finalPath);
    } catch (err) {
      if (await pathExists(state.finalPath)) {
        await archiveExisting(batch.inbox, state.finalPath, state.rel, this.settings.archiveEnabled !== false);
        await fsp.rename(state.partPath, state.finalPath);
      } else {
        throw err;
      }
    }
    await fsp.rm(state.sidecarPath, { force: true }).catch(() => {});
    state.finished = true;
    state.done.clear();
    state.hashes = {};
    this.activePaths.delete(state.finalPath);
    t.filesDone += 1;
    t.currentFile = state.rel;
    this.manager.emitState();
    if (archived) {
      this.manager.toast(
        archived.type === 'archive'
          ? `旧版本已移入归档：${path.basename(archived.path)}`
          : `已生成冲突副本：${path.basename(archived.path)}`,
        'info'
      );
    }

    if (t.filesDone >= t.totalFiles && !batch.canceled && batch.status === 'uploading') {
      this.completeBatch(batch);
    }
  }

  async finishBatch(res, batchId) {
    const batch = this.findBatch(res, batchId);
    if (!batch) return;
    if (batch.status !== 'uploading' || batch.canceled) {
      return sendJson(res, 200, {
        ok: true,
        filesDone: batch.transfer.filesDone,
        totalFiles: batch.transfer.totalFiles,
        complete: batch.status === 'completed',
        status: batch.status
      });
    }
    for (const state of batch.files) {
      if (state.finished) continue;
      if (state.done.size !== state.chunks) continue;
      try {
        state.finishing = state.finishing || this.finalizeFile(state);
        await state.finishing;
      } catch (err) {
        this.failBatch(batch, `保存文件失败：${err.message}`);
      } finally {
        state.finishing = null;
      }
      if (batch.status !== 'uploading') break;
    }
    if (batch.status === 'failed') {
      return sendJson(res, 500, { error: batch.transfer.error || '上传失败' });
    }
    if (batch.canceled) {
      return sendJson(res, 409, { error: '上传已取消', status: batch.status });
    }
    const pending = batch.files.filter((f) => !f.finished).map((f) => f.rel);
    return sendJson(res, 200, {
      ok: true,
      filesDone: batch.transfer.filesDone,
      totalFiles: batch.transfer.totalFiles,
      complete: batch.status === 'completed',
      pending
    });
  }

  async batchStatus(res, batchId) {
    const batch = this.batches.get(batchId);
    if (!batch) return sendJson(res, 404, { error: '上传任务不存在或已结束' });
    const t = batch.transfer;
    return sendJson(res, 200, {
      status: batch.status,
      bytes: t.bytes,
      totalBytes: t.totalBytes,
      filesDone: t.filesDone,
      totalFiles: t.totalFiles,
      error: t.error,
      files: batch.files.map((f) => ({
        id: f.id,
        path: f.rel,
        received: f.finished ? f.chunks : f.done.size,
        chunks: f.chunks,
        finished: f.finished
      }))
    });
  }

  async clientCancel(res, batchId) {
    const batch = this.batches.get(batchId);
    if (!batch) return sendJson(res, 200, { ok: true });
    if (batch.status === 'uploading') {
      await this.abortBatch(batch, 'canceled', '访客已取消上传');
    }
    return sendJson(res, 200, { ok: true });
  }

  cancelBatch(id, reason = '主机已取消上传') {
    const batch = this.batches.get(id);
    if (!batch) return false;
    if (batch.status === 'uploading') {
      this.abortBatch(batch, 'canceled', reason).catch(() => {});
    }
    return true;
  }

  async abortBatch(batch, status, reason) {
    if (batch.status !== 'uploading') return;
    batch.canceled = true;
    batch.status = status;
    this.clearFileTimers(batch);
    const jobs = [];
    for (const state of batch.files) {
      if (!state.finished && state.done.size) jobs.push(this.flushSidecar(state));
    }
    await Promise.allSettled(jobs);
    for (const state of batch.files) this.activePaths.delete(state.finalPath);
    batch.transfer.error = reason;
    this.manager.completeTransfer(batch.transfer, status === 'canceled' ? 'canceled' : 'failed', reason);
    this.scheduleCleanup(batch);
  }

  failBatch(batch, reason) {
    if (batch.status !== 'uploading') return;
    batch.canceled = true;
    batch.status = 'failed';
    this.clearFileTimers(batch);
    for (const state of batch.files) this.activePaths.delete(state.finalPath);
    this.manager.completeTransfer(batch.transfer, 'failed', reason);
    this.scheduleCleanup(batch);
  }

  completeBatch(batch) {
    if (batch.status !== 'uploading') return;
    batch.status = 'completed';
    this.clearFileTimers(batch);
    batch.transfer.currentFile = '';
    for (const state of batch.files) this.activePaths.delete(state.finalPath);
    this.manager.completeTransfer(batch.transfer, 'completed');
    this.scheduleCleanup(batch);
  }

  scheduleCleanup(batch) {
    if (batch.cleanupTimer) return;
    batch.cleanupTimer = setTimeout(() => {
      if (this.batches.get(batch.id) === batch) this.batches.delete(batch.id);
      batch.cleanupTimer = null;
    }, 5 * 60 * 1000);
    batch.cleanupTimer.unref?.();
  }

  clearFileTimers(batch) {
    for (const state of batch.files) {
      if (state.sidecarTimer) {
        clearTimeout(state.sidecarTimer);
        state.sidecarTimer = null;
      }
    }
  }

  clearTimers(batch) {
    this.clearFileTimers(batch);
    if (batch.cleanupTimer) {
      clearTimeout(batch.cleanupTimer);
      batch.cleanupTimer = null;
    }
  }

  tick(now) {
    for (const [sid, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(sid);
    }
    for (const [ip, rate] of this.loginRates) {
      if (rate.resetAt < now && rate.blockedUntil < now) this.loginRates.delete(ip);
    }
    for (const batch of this.batches.values()) {
      if (batch.status !== 'uploading') continue;
      if (now - batch.lastActivity > IDLE_MS) {
        this.abortBatch(batch, 'failed', '访客上传超时').catch(() => {});
      }
    }
  }

  async cleanupStaleParts() {
    const now = Date.now();
    if (now - this.lastCleanup < 60 * 60 * 1000) return;
    this.lastCleanup = now;
    const ttlHours = Number(this.settings.partialTtlHours);
    if (!Number.isFinite(ttlHours) || ttlHours <= 0) return;
    const ttl = ttlHours * 3600 * 1000;
    const root = this.inboxRoot;
    if (!(await pathExists(root))) return;
    const active = new Set();
    for (const batch of this.batches.values()) {
      for (const state of batch.files) active.add(state.sidecarPath);
    }
    const walk = async (dir, depth) => {
      if (depth > 24) return;
      let items;
      try {
        items = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const item of items) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) {
          if (item.name === ARCHIVE_NAME) continue;
          await walk(full, depth + 1);
          continue;
        }
        if (!item.isFile() || !item.name.endsWith('.lanlink-part.json')) continue;
        if (active.has(full)) continue;
        try {
          const sidecar = JSON.parse(await fsp.readFile(full, 'utf8'));
          const age = now - new Date(sidecar.updatedAt || 0).getTime();
          if (!(age > ttl)) continue;
          const stat = await fsp.stat(full);
          if (now - stat.mtimeMs < ttl) continue;
          await fsp.rm(full.replace(/\.json$/, ''), { force: true });
          await fsp.rm(full, { force: true });
          this.onLog?.(`cleaned stale guest part: ${full}`);
        } catch {
          /* ignore */
        }
      }
    };
    await walk(root, 0);
  }
}

module.exports = { GuestServer, lanUrls, INBOX_NAME, CHUNK };
