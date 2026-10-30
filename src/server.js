'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const { spawn } = require('node:child_process');
const { URL } = require('node:url');
const { Manager } = require('./core/manager');

const UI_DIR = path.join(__dirname, 'ui');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function parseArgs(argv) {
  const args = { autoTrust: false, discovery: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--data') args.dataDir = next();
    else if (a === '--ui-port') args.uiPort = Number(next());
    else if (a === '--tcp-port') args.tcpPort = Number(next());
    else if (a === '--discovery-port') args.discoveryPort = Number(next());
    else if (a === '--name') args.name = next();
    else if (a === '--auto-trust') args.autoTrust = true;
    else if (a === '--no-discovery') args.discovery = false;
    else if (a === '--verbose') args.verbose = true;
  }
  return args;
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
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
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const file = path.resolve(UI_DIR, rel);
  if (!file.startsWith(path.resolve(UI_DIR) + path.sep)) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'"
    });
    fs.createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

async function listDirectories(target) {
  const raw = String(target || '').trim();
  if (!raw) {
    const entries = [];
    if (process.platform === 'win32') {
      const drives = await Promise.all('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(async (letter) => {
        const root = `${letter}:\\`;
        const stat = await fsp.stat(root).catch(() => null);
        return stat && stat.isDirectory() ? { name: `${letter}:`, path: root } : null;
      }));
      entries.push(...drives.filter(Boolean));
    } else {
      entries.push({ name: '/', path: '/' });
      const home = process.env.HOME || process.env.USERPROFILE;
      if (home && home !== '/') entries.push({ name: path.basename(home) || home, path: home });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
    return { path: '', parent: null, entries };
  }
  if (!path.isAbsolute(raw)) throw new Error('请输入绝对路径');
  const dir = path.resolve(raw);
  const stat = await fsp.stat(dir).catch(() => null);
  if (!stat) throw new Error('路径不存在');
  if (!stat.isDirectory()) throw new Error('不是文件夹');
  const dirents = await fsp.readdir(dir, { withFileTypes: true });
  const entries = [];
  for (const entry of dirents) {
    if (entries.length >= 2000) break;
    if (entry.isDirectory()) entries.push({ name: entry.name, path: path.join(dir, entry.name) });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
  const parent = path.dirname(dir);
  return { path: dir, parent: parent === dir ? null : parent, entries };
}

async function revealPathNative(target) {
  const raw = String(target || '').trim();
  if (!raw || !path.isAbsolute(raw)) throw new Error('无效路径');
  const file = path.resolve(raw);
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat) throw new Error('路径不存在');
  let cmd;
  let args;
  if (process.platform === 'win32') {
    cmd = 'explorer.exe';
    args = [stat.isDirectory() ? file : `/select,${file}`];
  } else if (process.platform === 'darwin') {
    cmd = 'open';
    args = [file];
  } else {
    cmd = 'xdg-open';
    args = [file];
  }
  await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', resolve);
    child.unref();
  });
}

async function startServer(opts = {}) {
  const manager = new Manager({ ...opts, uiDir: UI_DIR });
  await manager.start();

  const clients = new Set();
  let broadcastTimer = null;
  const broadcast = () => {
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      if (!clients.size) return;
      let data;
      try { data = JSON.stringify(manager.snapshot()); } catch { return; }
      for (const res of clients) {
        try { res.write(`event: state\ndata: ${data}\n\n`); } catch { /* noop */ }
      }
    }, 150);
    broadcastTimer.unref?.();
  };

  manager.on('state', broadcast);
  manager.on('toast', (toast) => {
    for (const res of clients) {
      try { res.write(`event: toast\ndata: ${JSON.stringify(toast)}\n\n`); } catch { /* noop */ }
    }
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;
    try {
      if (req.method === 'GET' && pathname === '/api/state') {
        return sendJson(res, 200, manager.snapshot());
      }
      if (req.method === 'GET' && pathname === '/api/health') {
        return sendJson(res, 200, { ok: true, uptime: process.uptime() });
      }
      if (req.method === 'GET' && pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no'
        });
        res.write(`retry: 1500\n\n`);
        res.write(`event: state\ndata: ${JSON.stringify(manager.snapshot())}\n\n`);
        clients.add(res);
        const timer = setInterval(() => {
          try { res.write(': keepalive\n\n'); } catch { /* noop */ }
        }, 20000);
        timer.unref?.();
        req.on('close', () => {
          clearInterval(timer);
          clients.delete(res);
        });
        return;
      }
      if (req.method === 'POST' && pathname === '/api/send') {
        const body = await readBody(req);
        if (typeof body.peerId !== 'string' || !Array.isArray(body.paths) || !body.paths.length) {
          return sendJson(res, 400, { error: '缺少 peerId 或 paths' });
        }
        const paths = body.paths.filter((p) => typeof p === 'string' && p.trim());
        if (!paths.length) return sendJson(res, 400, { error: '没有有效路径' });
        const result = await manager.send(body.peerId, paths);
        return sendJson(res, 200, result);
      }
      if (req.method === 'POST' && pathname === '/api/connect') {
        const body = await readBody(req);
        if (!body.host || !body.port) return sendJson(res, 400, { error: '需要 host 和 port' });
        let result;
        try {
          result = await manager.dialManual(String(body.host), Number(body.port));
        } catch (err) {
          if (err.code === 'PAIR_CODE_REQUIRED') {
            return sendJson(res, 409, { error: err.message, code: err.code, peer: err.peer || null });
          }
          throw err;
        }
        return sendJson(res, 200, { peer: result.peer, sas: result.sas, trusted: result.trusted });
      }
      if (req.method === 'POST' && pathname === '/api/disconnect') {
        const body = await readBody(req);
        if (typeof body.peerId !== 'string' || !body.peerId) return sendJson(res, 400, { error: '缺少 peerId' });
        await manager.disconnectPeer(body.peerId);
        return sendJson(res, 200, { ok: true });
      }
      const historyRemoveMatch = pathname.match(/^\/api\/history\/([0-9a-f]+)$/);
      if (req.method === 'POST' && historyRemoveMatch) {
        await manager.removeHistory(historyRemoveMatch[1]);
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && pathname === '/api/history/clear') {
        await manager.clearHistory();
        return sendJson(res, 200, { ok: true });
      }
      const pairMatch = pathname.match(/^\/api\/pair\/([0-9a-zA-Z_-]+)$/);
      if (req.method === 'POST' && pairMatch) {
        const body = await readBody(req);
        if (body.accept) await manager.acceptPair(pairMatch[1]);
        else await manager.declinePair(pairMatch[1]);
        return sendJson(res, 200, { ok: true });
      }
      const declineMatch = pathname.match(/^\/api\/incoming\/([0-9a-z]+)\/decline$/);
      if (req.method === 'POST' && declineMatch) {
        await manager.declineIncoming(declineMatch[1]);
        return sendJson(res, 200, { ok: true });
      }
      const acceptMatch = pathname.match(/^\/api\/incoming\/([0-9a-z]+)\/accept$/);
      if (req.method === 'POST' && acceptMatch) {
        const body = await readBody(req);
        const t = await manager.acceptIncoming(acceptMatch[1], body.destDir);
        return sendJson(res, 200, { ok: true, destDir: t.destDir });
      }
      const cancelMatch = pathname.match(/^\/api\/transfers\/([0-9a-z]+)\/cancel$/);
      if (req.method === 'POST' && cancelMatch) {
        manager.cancelTransfer(cancelMatch[1]);
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && pathname === '/api/settings') {
        const body = await readBody(req);
        await manager.updateSettings(body);
        return sendJson(res, 200, manager.snapshot().settings);
      }
      if (req.method === 'POST' && pathname === '/api/settings/reset') {
        await manager.resetSettings();
        return sendJson(res, 200, manager.snapshot().settings);
      }
      if (req.method === 'POST' && pathname === '/api/guest/rotate') {
        const info = await manager.rotateGuestAccess();
        return sendJson(res, 200, info);
      }
      if (req.method === 'POST' && pathname === '/api/reveal') {
        const body = await readBody(req);
        const reveal = typeof opts.onReveal === 'function' ? opts.onReveal : revealPathNative;
        await reveal(String(body.path || ''));
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && pathname === '/api/list-dir') {
        const body = await readBody(req);
        return sendJson(res, 200, await listDirectories(body.path));
      }
      if (req.method === 'POST' && pathname === '/api/shutdown') {
        sendJson(res, 200, { ok: true });
        setTimeout(() => close(), 50);
        return;
      }
      if (pathname.startsWith('/api/')) {
        return sendJson(res, 404, { error: 'not found' });
      }
      return serveStatic(req, res, pathname);
    } catch (err) {
      opts.log?.(err.stack || err.message);
      return sendJson(res, 400, { error: err.message || String(err) });
    }
  });

  let uiPort = 0;
  const requestedUiPort = Number.isFinite(opts.uiPort) ? opts.uiPort : 7410;
  for (let attempt = 0; attempt <= 20; attempt++) {
    try {
      uiPort = await listen(server, requestedUiPort ? requestedUiPort + attempt : 0, '127.0.0.1');
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || attempt === 20) throw err;
    }
  }
  manager.setUiPort(uiPort);

  async function close() {
    for (const res of clients) {
      try { res.end(); } catch { /* noop */ }
    }
    clients.clear();
    await new Promise((resolve) => server.close(() => resolve()));
    await manager.shutdown();
  }

  return { manager, server, uiPort, url: `http://127.0.0.1:${uiPort}`, close, opts };
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  startServer({
    ...args,
    log: args.verbose ? (msg) => console.error(`[lanlink] ${msg}`) : undefined
  })
    .then((app) => {
      console.log(`LanLink GUI: ${app.url}`);
      console.log(`Device: ${app.manager.identity.name} (${app.manager.identity.id})`);
      console.log(`TCP port: ${app.manager.tcpPort}  Discovery: ${app.manager.discoveryPort}`);
      const shutdown = () => app.close().then(() => process.exit(0));
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((err) => {
      console.error('LanLink failed to start:', err);
      process.exit(1);
    });
}

module.exports = { startServer, parseArgs };
