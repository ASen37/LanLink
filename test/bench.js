'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SERVER = path.join(__dirname, '..', 'src', 'server.js');

async function waitFor(label, fn, timeout = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await fn();
    if (value) return value;
    await delay(40);
  }
  throw new Error(`等待超时：${label}`);
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `POST ${url} -> ${res.status}`);
  return data;
}

async function state(url) {
  const res = await fetch(`${url}/api/state`, { cache: 'no-store' });
  return res.json();
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function startNode(name, dataDir) {
  const uiPort = await freePort();
  const tcpPort = await freePort();
  const child = spawn(process.execPath, [
    SERVER,
    '--data', dataDir,
    '--ui-port', String(uiPort),
    '--tcp-port', String(tcpPort),
    '--no-discovery',
    '--auto-trust',
    '--name', name
  ], { stdio: 'ignore' });
  const url = `http://127.0.0.1:${uiPort}`;
  await waitFor(`${name} 启动`, async () => {
    try {
      const res = await fetch(`${url}/api/state`, { cache: 'no-store' });
      return res.ok;
    } catch {
      return false;
    }
  });
  return { name, url, tcpPort, child };
}

async function stopNode(node) {
  if (!node) return;
  node.child.kill();
  await Promise.race([
    new Promise((resolve) => node.child.once('exit', resolve)),
    delay(3000)
  ]);
}

async function writeBig(file, size) {
  const chunk = crypto.randomBytes(4 * 1024 * 1024);
  const fh = await fsp.open(file, 'w');
  try {
    let written = 0;
    while (written < size) {
      const len = Math.min(chunk.length, size - written);
      await fh.write(chunk, 0, len, written);
      written += len;
    }
  } finally {
    await fh.close();
  }
}

async function writeSmall(dir, count, size) {
  await fsp.mkdir(dir, { recursive: true });
  const chunk = crypto.randomBytes(size);
  await Promise.all(Array.from({ length: 20 }, async (_, worker) => {
    for (let i = worker; i < count; i += 20) {
      await fsp.writeFile(path.join(dir, `file-${String(i).padStart(5, '0')}.bin`), chunk);
    }
  }));
}

async function measure(url, rootLabel) {
  let active = false;
  let fast = null;
  await waitFor('传输开始', async () => {
    const s = await state(url);
    const t = s.transfers.find((x) => x.rootLabel === rootLabel && x.direction === 'out');
    if (t && t.progress > 0) {
      active = true;
      return true;
    }
    const h = s.history.find((x) => x.rootLabel === rootLabel && x.direction === 'out');
    if (h) {
      active = false;
      fast = h;
      return true;
    }
    return false;
  });
  if (!active && fast) {
    const elapsed = Math.max(1, (fast.endedAt || Date.now()) - (fast.startedAt || Date.now()));
    return {
      elapsed,
      totalBytes: fast.totalBytes,
      samples: [(fast.totalBytes / 1048576) / (elapsed / 1000)],
      status: fast.status
    };
  }
  const samples = [];
  const start = Date.now();
  let lastBytes = 0;
  let lastAt = start;
  for (;;) {
    const s = await state(url);
    const t = s.transfers.find((x) => x.rootLabel === rootLabel && x.direction === 'out');
    if (!t) {
      const h = s.history.find((x) => x.rootLabel === rootLabel && x.direction === 'out');
      if (h) {
        return { elapsed: (h.endedAt || Date.now()) - start, totalBytes: h.totalBytes, samples, status: h.status };
      }
      await delay(40);
      continue;
    }
    const now = Date.now();
    const delta = Math.max(0, t.bytes - lastBytes);
    const dt = (now - lastAt) / 1000;
    if (dt > 0) samples.push((delta / 1024 / 1024) / dt);
    lastBytes = t.bytes;
    lastAt = now;
    await delay(40);
  }
}

async function runOnce({ label, sizeMB, smallCount, smallSize }) {
  const root = path.join(__dirname, '..', 'dev', `bench-${label}-${Date.now()}`);
  const received = path.join(root, 'received');
  const bigFile = path.join(root, 'bench-big.bin');
  const smallDir = path.join(root, 'bench-small');
  const size = Math.round(sizeMB * 1024 * 1024);

  const prepStart = Date.now();
  await fsp.mkdir(root, { recursive: true });
  await writeBig(bigFile, size);
  await writeSmall(smallDir, smallCount, smallSize);
  const prepMs = Date.now() - prepStart;

  let a = null;
  let b = null;
  try {
    a = await startNode('Bench-A', path.join(root, 'node-a'));
    b = await startNode('Bench-B', path.join(root, 'node-b'));
    await post(`${a.url}/api/settings`, { downloadDir: received, autoAccept: true, archiveEnabled: true, discoveryEnabled: false });
    await post(`${b.url}/api/connect`, { host: '127.0.0.1', port: a.tcpPort });
    const aId = (await state(a.url)).device.id;
    await waitFor('配对完成', async () => {
      const s = await state(b.url);
      return s.peers.find((p) => p.id === aId && p.trusted && p.online);
    });

    await post(`${b.url}/api/send`, { peerId: aId, paths: [bigFile] });
    const big = await measure(b.url, 'bench-big.bin');
    const rates = big.samples.filter((x) => x > 0).sort((x, y) => x - y);
    const pick = (q) => rates.length ? rates[Math.min(rates.length - 1, Math.floor(rates.length * q))] : 0;

    await post(`${b.url}/api/send`, { peerId: aId, paths: [smallDir] });
    const small = await measure(b.url, 'bench-small');

    return {
      label,
      sizeMB,
      prepMs,
      big: {
        elapsedMs: big.elapsed,
        avgMBps: Number(((big.totalBytes / 1048576) / Math.max(0.001, big.elapsed / 1000)).toFixed(2)),
        p50MBps: Number(pick(0.5).toFixed(2)),
        p90MBps: Number(pick(0.9).toFixed(2)),
        maxMBps: Number(pick(0.999).toFixed(2)),
        status: big.status
      },
      small: {
        count: smallCount,
        sizeBytes: smallSize,
        elapsedMs: small.elapsed,
        avgMBps: Number(((small.totalBytes / 1048576) / Math.max(0.001, small.elapsed / 1000)).toFixed(2)),
        filesPerSec: Number((smallCount / Math.max(0.001, small.elapsed / 1000)).toFixed(1)),
        status: small.status
      }
    };
  } finally {
    await stopNode(b);
    await stopNode(a);
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

const label = process.env.BENCH_LABEL || 'run';
const sizeMB = Number(process.env.BENCH_SIZE_MB || 512);
const smallCount = Number(process.env.BENCH_SMALL_COUNT || 2000);
const smallSize = Number(process.env.BENCH_SMALL_SIZE || 4096);

runOnce({ label, sizeMB, smallCount, smallSize })
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
