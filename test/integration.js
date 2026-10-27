'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { startServer } = require('../src/server');
const { pieceSizeFor, hashFileChunks, safeJoin } = require('../src/core/util');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label, fn, { timeout = 60000, fatal = false } = {}) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeout) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (err) {
      if (fatal) throw err;
      lastError = err;
    }
    await delay(200);
  }
  throw new Error(`等待超时：${label}${lastError ? `（${lastError.message}）` : ''}`);
}

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  let data = {};
  try { data = await res.json(); } catch { /* noop */ }
  if (!res.ok) throw new Error(data.error || `POST ${url} -> ${res.status}`);
  return data;
}

function sha256FileAsync(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

async function listFiles(root) {
  const out = [];
  async function walk(dir, rel = '') {
    const items = await fsp.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const nextRel = rel ? `${rel}/${item.name}` : item.name;
      const abs = path.join(dir, item.name);
      if (item.isDirectory()) await walk(abs, nextRel);
      else if (item.isFile()) out.push({ rel: nextRel, abs });
    }
  }
  await walk(root);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

async function waitTransfer(app, direction, rootLabel, id) {
  const entry = await waitFor(`${direction}:${rootLabel}${id ? `#${id}` : ''}`, async () => {
    const state = await getJson(`${app.url}/api/state`);
    const match = state.history.find((h) => h.direction === direction && h.rootLabel === rootLabel && (!id || h.id === id));
    return match || null;
  });
  assert.equal(entry.status, 'completed', `传输失败: ${entry.error || entry.status}`);
  return entry;
}

async function snapshot(app) {
  return getJson(`${app.url}/api/state`);
}

function startProxy(targetPort) {
  return new Promise((resolve, reject) => {
    const captured = [];
    const sockets = new Set();
    const server = net.createServer((client) => {
      const upstream = net.connect({ host: '127.0.0.1', port: targetPort });
      sockets.add(client);
      sockets.add(upstream);
      client.on('data', (data) => {
        captured.push(Buffer.from(data));
        upstream.write(data);
      });
      upstream.on('data', (data) => client.write(data));
      client.on('error', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        captured,
        close: () => new Promise((done) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => done());
        })
      });
    });
  });
}

async function main() {
  const stamp = Date.now();
  const root = path.join(__dirname, '..', 'dev', `integration-${stamp}`);
  const payload = path.join(root, 'payload');
  const receivedA = path.join(root, 'received-a');
  const receivedC = path.join(root, 'received-c');
  const receivedE = path.join(root, 'received-e');

  const traversalRoot = path.join(root, 'traversal');
  for (const bad of ['../escape.txt', '..\\..\\escape.txt', '/etc/passwd', 'C:\\Windows\\win.ini', 'nested/../../escape.txt']) {
    const resolved = safeJoin(traversalRoot, bad);
    assert.ok(resolved === path.resolve(traversalRoot) || resolved.startsWith(path.resolve(traversalRoot) + path.sep), `路径逃逸: ${bad} -> ${resolved}`);
  }
  assert.equal(safeJoin(traversalRoot, 'a/b.txt'), path.join(traversalRoot, 'a', 'b.txt'));
  console.log('✓ 路径穿越被约束在目标目录内');
  await fsp.mkdir(path.join(payload, 'nested'), { recursive: true });
  await fsp.mkdir(path.join(payload, 'emptydir'), { recursive: true });

  const report = path.join(payload, 'report.txt');
  const binary = path.join(payload, 'nested', 'data.bin');
  const emptyFile = path.join(payload, 'nested', 'empty.txt');
  await fsp.writeFile(report, 'lanlink integration v1\n');
  await fsp.writeFile(binary, crypto.randomBytes(2 * 1024 * 1024 + 12345));
  await fsp.writeFile(emptyFile, '');
  const oldMtime = new Date('2020-01-02T03:04:05Z');
  await fsp.utimes(report, oldMtime, oldMtime);

  const sourceBefore = new Map();
  for (const file of await listFiles(payload)) {
    sourceBefore.set(file.rel, await sha256FileAsync(file.abs));
  }

  let a = null;
  let b = null;
  let c = null;
  let d = null;
  let e = null;
  let f = null;
  let proxy = null;
  try {
    a = await startServer({ dataDir: path.join(root, 'node-a'), uiPort: 0, tcpPort: 0, discovery: false, autoTrust: true, name: 'Node-A' });
    b = await startServer({ dataDir: path.join(root, 'node-b'), uiPort: 0, tcpPort: 0, discovery: false, autoTrust: true, name: 'Node-B' });

    await postJson(`${a.url}/api/settings`, {
      downloadDir: receivedA,
      autoAccept: true,
      archiveEnabled: true,
      discoveryEnabled: false
    });

    await postJson(`${b.url}/api/connect`, { host: '127.0.0.1', port: a.manager.tcpPort });
    const linked = await waitFor('自动配对', async () => {
      const state = await snapshot(b);
      const peer = state.peers.find((p) => p.id === a.manager.identity.id);
      return peer && peer.trusted && peer.online ? peer : null;
    });
    assert.equal(linked.id, a.manager.identity.id);
    console.log('✓ TCP 连接与自动配对');

    const sendResult = await postJson(`${b.url}/api/send`, { peerId: a.manager.identity.id, paths: [payload] });
    assert.ok(sendResult.id, '缺少传输 ID');
    await waitTransfer(b, 'out', 'payload', sendResult.id);
    await waitTransfer(a, 'in', 'payload', sendResult.id);
    console.log('✓ 文件夹传输（含嵌套目录、空文件）完成');

    const receivedRoot = path.join(receivedA, 'payload');
    const receivedFiles = await listFiles(receivedRoot);
    assert.equal(receivedFiles.length, sourceBefore.size, '接收到的文件数量不一致');
    for (const file of receivedFiles) {
      const expected = sourceBefore.get(file.rel.replace(/\\/g, '/'));
      assert.ok(expected, `多出的文件: ${file.rel}`);
      assert.equal(await sha256FileAsync(file.abs), expected, `内容不一致: ${file.rel}`);
    }
    const emptyDirStat = await fsp.stat(path.join(receivedRoot, 'emptydir'));
    assert.ok(emptyDirStat.isDirectory(), '空目录未创建');
    const receivedMtime = (await fsp.stat(path.join(receivedRoot, 'report.txt'))).mtimeMs;
    assert.ok(receivedMtime > Date.now() - 120000 && receivedMtime <= Date.now(), '落盘文件应使用接收时间作为修改日期');
    console.log('✓ 逐文件 SHA-256 与目录结构校验通过');

    const resend = await postJson(`${b.url}/api/send`, { peerId: a.manager.identity.id, paths: [payload] });
    await waitTransfer(b, 'out', 'payload', resend.id);
    await waitTransfer(a, 'in', 'payload', resend.id);
    const archiveDir = path.join(receivedA, '.lanlink-archive');
    assert.equal(fs.existsSync(archiveDir), false, '内容相同却产生了归档');
    console.log('✓ 相同内容重复发送被安全跳过');

    await fsp.writeFile(report, 'lanlink integration v2 - changed\n');
    const changed = await postJson(`${b.url}/api/send`, { peerId: a.manager.identity.id, paths: [payload] });
    await waitTransfer(b, 'out', 'payload', changed.id);
    await waitTransfer(a, 'in', 'payload', changed.id);
    assert.equal(fs.readFileSync(path.join(receivedRoot, 'report.txt'), 'utf8'), 'lanlink integration v2 - changed\n');
    const archived = await listFiles(archiveDir);
    const oldReport = archived.find((f) => f.rel.endsWith('report.txt'));
    assert.ok(oldReport, '未找到旧版本归档');
    assert.equal(fs.readFileSync(oldReport.abs, 'utf8'), 'lanlink integration v1\n', '归档内容不是旧版本');
    console.log('✓ 覆盖同名文件时旧版本进入 .lanlink-archive');

    await postJson(`${a.url}/api/settings`, { archiveEnabled: false });
    await fsp.writeFile(report, 'lanlink integration v3 - conflict\n');
    const conflictSend = await postJson(`${b.url}/api/send`, { peerId: a.manager.identity.id, paths: [payload] });
    await waitTransfer(b, 'out', 'payload', conflictSend.id);
    await waitTransfer(a, 'in', 'payload', conflictSend.id);
    assert.equal(fs.readFileSync(path.join(receivedRoot, 'report.txt'), 'utf8'), 'lanlink integration v3 - conflict\n');
    const conflictFiles = await listFiles(receivedRoot);
    const conflictCopy = conflictFiles.find((file) => /report \(conflict copy .*\)\.txt$/.test(file.rel));
    assert.ok(conflictCopy, '关闭归档后未生成冲突副本');
    assert.equal(fs.readFileSync(conflictCopy.abs, 'utf8'), 'lanlink integration v2 - changed\n');
    await postJson(`${a.url}/api/settings`, { archiveEnabled: true });
    console.log('✓ 关闭归档时改为生成冲突副本');

    const resumeData = crypto.randomBytes(8 * 1024 * 1024 + 4321);
    const resumeSrc = path.join(root, 'resume.bin');
    await fsp.writeFile(resumeSrc, resumeData);
    const resumePiece = pieceSizeFor(resumeData.length);
    const resumeInfo = await hashFileChunks(resumeSrc, resumePiece);
    const doneCount = Math.max(1, Math.floor(resumeInfo.chunks.length / 2));
    const partBuf = Buffer.alloc(resumeInfo.size);
    resumeData.copy(partBuf, 0, 0, doneCount * resumePiece);
    await fsp.mkdir(receivedA, { recursive: true });
    const destPart = path.join(receivedA, 'resume.bin.lanlink-part');
    await fsp.writeFile(destPart, partBuf);
    await fsp.writeFile(`${destPart}.json`, JSON.stringify({
      treeHash: resumeInfo.treeHash,
      size: resumeInfo.size,
      done: Array.from({ length: doneCount }, (_, i) => i),
      updatedAt: new Date().toISOString()
    }));

    const resumeSend = await postJson(`${b.url}/api/send`, { peerId: a.manager.identity.id, paths: [resumeSrc] });
    let maxResumed = 0;
    let watching = true;
    const watcher = (async () => {
      while (watching) {
        try {
          const state = await snapshot(a);
          const transfer = state.transfers.find((t) => t.id === resumeSend.id);
          if (transfer) maxResumed = Math.max(maxResumed, transfer.resumedBytes || 0);
        } catch { /* retry */ }
        await delay(40);
      }
    })();
    try {
      await waitTransfer(b, 'out', 'resume.bin', resumeSend.id);
      await waitTransfer(a, 'in', 'resume.bin', resumeSend.id);
    } finally {
      watching = false;
      await watcher;
    }
    assert.ok(maxResumed >= doneCount * resumePiece, `续传统计异常: ${maxResumed}`);
    assert.equal(fs.readFileSync(path.join(receivedA, 'resume.bin')).equals(resumeData), true, '续传后内容不一致');
    assert.equal(fs.existsSync(destPart), false, '续传完成后临时文件未清理');
    assert.equal(fs.existsSync(`${destPart}.json`), false, '续传完成后 sidecar 未清理');
    console.log(`✓ 断点续传（跳过 ${doneCount}/${resumeInfo.chunks.length} 个已有分块）`);

    e = await startServer({ dataDir: path.join(root, 'node-e'), uiPort: 0, tcpPort: 0, discovery: false, autoTrust: true, name: 'Node-E' });
    f = await startServer({ dataDir: path.join(root, 'node-f'), uiPort: 0, tcpPort: 0, discovery: false, autoTrust: true, name: 'Node-F' });
    await postJson(`${e.url}/api/settings`, {
      downloadDir: receivedE,
      autoAccept: true,
      archiveEnabled: true,
      discoveryEnabled: false
    });
    proxy = await startProxy(e.manager.tcpPort);
    await postJson(`${f.url}/api/connect`, { host: '127.0.0.1', port: proxy.port });
    await waitFor('经代理连接', async () => {
      const state = await snapshot(f);
      const peer = state.peers.find((p) => p.id === e.manager.identity.id);
      return peer && peer.trusted && peer.online ? peer : null;
    });
    const marker = `LANLINK-PLAINTEXT-${crypto.randomBytes(8).toString('hex')}`;
    const secret = path.join(root, 'wire-check.txt');
    await fsp.writeFile(secret, `${marker}\n${crypto.randomBytes(200 * 1024).toString('base64')}\n`);
    const secretSend = await postJson(`${f.url}/api/send`, { peerId: e.manager.identity.id, paths: [secret] });
    await waitTransfer(f, 'out', 'wire-check.txt', secretSend.id);
    await waitTransfer(e, 'in', 'wire-check.txt', secretSend.id);
    await delay(300);
    const wire = Buffer.concat(proxy.captured).toString('latin1');
    assert.ok(wire.length > 1024, '未捕获到网络流量');
    assert.equal(wire.includes(marker), false, '文件明文出现在网络流量中');
    assert.equal(fs.readFileSync(path.join(receivedE, 'wire-check.txt'), 'utf8').startsWith(marker), true);
    await proxy.close();
    proxy = null;
    console.log('✓ 网络抓包中未出现文件明文（AES-256-GCM 生效）');

    c = await startServer({ dataDir: path.join(root, 'node-c'), uiPort: 0, tcpPort: 0, discovery: false, autoTrust: false, name: 'Node-C' });
    d = await startServer({ dataDir: path.join(root, 'node-d'), uiPort: 0, tcpPort: 0, discovery: false, autoTrust: false, name: 'Node-D' });
    await postJson(`${c.url}/api/settings`, {
      downloadDir: receivedC,
      autoAccept: true,
      archiveEnabled: true,
      discoveryEnabled: false
    });
    await postJson(`${d.url}/api/connect`, { host: '127.0.0.1', port: c.manager.tcpPort });

    const pairInfo = await waitFor('双方出现配对请求', async () => {
      const sc = await snapshot(c);
      const sd = await snapshot(d);
      if (!sc.pairRequests.length || !sd.pairRequests.length) return null;
      return { c: sc.pairRequests[0], d: sd.pairRequests[0] };
    });
    assert.equal(pairInfo.c.sas, pairInfo.d.sas, '两端 6 位验证码不一致');
    assert.match(pairInfo.c.sas, /^\d{6}$/);
    await postJson(`${c.url}/api/pair/${d.manager.identity.id}`, { accept: true });
    await waitFor('配对完成', async () => {
      const sd = await snapshot(d);
      const peer = sd.peers.find((p) => p.id === c.manager.identity.id);
      return peer && peer.trusted ? peer : null;
    });
    console.log(`✓ 手动配对流程（验证码 ${pairInfo.c.sas} 两端一致）`);

    const small = path.join(root, 'pair-note.txt');
    await fsp.writeFile(small, 'paired transfer ok\n');
    const pairedSend = await postJson(`${d.url}/api/send`, { peerId: c.manager.identity.id, paths: [small] });
    await waitTransfer(d, 'out', 'pair-note.txt', pairedSend.id);
    await waitTransfer(c, 'in', 'pair-note.txt', pairedSend.id);
    assert.equal(fs.readFileSync(path.join(receivedC, 'pair-note.txt'), 'utf8'), 'paired transfer ok\n');
    console.log('✓ 配对后单文件传输校验通过');

    const finalState = await snapshot(a);
    assert.ok(finalState.device.discoveryPort > 0, '快照缺少发现端口');
    console.log('✓ 设置与状态快照接口正常');

    console.log('\n全部集成测试通过');
  } finally {
    if (proxy) {
      try { await proxy.close(); } catch { /* noop */ }
    }
    for (const app of [f, e, b, a, d, c]) {
      if (!app) continue;
      try { await app.close(); } catch { /* noop */ }
    }
    if (!process.env.LANLINK_KEEP) {
      await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    } else {
      console.log(`测试数据保留在: ${root}`);
    }
  }
}

const watchdog = setTimeout(() => {
  console.error('集成测试超时');
  process.exit(1);
}, 240000);
watchdog.unref?.();

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n集成测试失败：');
    console.error(err.stack || err.message);
    process.exit(1);
  });
