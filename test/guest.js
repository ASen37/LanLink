'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { startServer } = require('../src/server');

const CHUNK = 4 * 1024 * 1024;

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (d) => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

function startProxy(targetPort) {
  const { net } = require('node:net');
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function guestFetch(base, pathname, { method = 'GET', cookie, body, headers = {} } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers
    },
    body
  });
  let data = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  return { res, data };
}

async function main() {
  const stamp = Date.now();
  const root = path.join(__dirname, '..', 'dev', `guest-test-${stamp}`);
  const downloadDir = path.join(root, 'downloads');
  const shareDir = path.join(root, 'share');
  await fsp.mkdir(path.join(shareDir, 'sub'), { recursive: true });
  await fsp.writeFile(path.join(shareDir, 'a.txt'), 'hello guest');
  await fsp.writeFile(path.join(shareDir, 'sub', 'b.bin'), Buffer.from([1, 2, 3, 4, 5]));
  await fsp.writeFile(path.join(shareDir, '.hidden'), 'nope');
  const app = await startServer({
    dataDir: path.join(root, 'host'),
    uiPort: 0,
    tcpPort: 0,
    discovery: false,
    name: 'Guest-Host'
  });

  const host = `${app.url}`;
  const post = async (p, body) => {
    const res = await fetch(`${host}${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    return { res, data: await res.json().catch(() => ({})) };
  };

  try {
    const enabled = await post('/api/settings', {
      downloadDir,
      discoveryEnabled: false,
      guestEnabled: true,
      guestPort: 0,
      guestExpiryHours: 1,
      guestMaxFileMB: 100,
      guestMaxBatchMB: 200,
      guestShareDir: shareDir
    });
    assert.equal(enabled.res.status, 200);
    let state = await (await fetch(`${host}/api/state`)).json();
    assert.equal(state.guest.running, true, '访客监听未启动');
    assert.match(state.guest.code, /^\d{6}$/);
    const link = state.guest.urls[0];
    assert.ok(link, '缺少访客链接');
    const parsed = new URL(link);
    const token = parsed.pathname.split('/').pop();
    const base = `${parsed.origin}/u/${token}`;
    assert.equal(parsed.port, String(state.guest.port));
    console.log(`✓ 访客监听已启动（端口 ${state.guest.port}，访问码 ${state.guest.code}）`);

    let r = await guestFetch(base, '/api/info');
    assert.equal(r.res.status, 401, '未登录却可访问 API');
    r = await guestFetch(base, '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '000000' })
    });
    assert.equal(r.res.status, 403, '错误访问码未被拒绝');
    r = await guestFetch(base, '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: state.guest.code })
    });
    assert.equal(r.res.status, 200, '正确访问码登录失败');
    const cookie = r.res.headers.getSetCookie()[0].split(';')[0];
    assert.ok(cookie.includes('lanlink_guest='));
    console.log('✓ 令牌 + 访问码登录与错误码拒绝');

    // ---- 共享目录（只读下载） ----
    r = await guestFetch(base, '/api/share/list?path=', { cookie });
    assert.equal(r.res.status, 200);
    assert.deepEqual(r.data.entries.map((e) => e.name), ['sub', 'a.txt'], '下载列表应只含可见项');
    r = await guestFetch(base, '/api/share/file?path=a.txt', { cookie });
    assert.equal(r.res.status, 200);
    assert.equal(r.data, 'hello guest');
    assert.match(r.res.headers.get('content-disposition') || '', /attachment/);
    r = await guestFetch(base, '/api/share/file?path=a.txt', { cookie, headers: { Range: 'bytes=0-4' } });
    assert.equal(r.res.status, 206);
    assert.equal(r.data, 'hello');
    assert.equal(r.res.headers.get('content-range'), 'bytes 0-4/11');
    r = await guestFetch(base, `/api/share/file?path=${encodeURIComponent('../host/identity.json')}`, { cookie });
    assert.equal(r.res.status, 403, '目录穿越未被拦截');
    r = await guestFetch(base, `/api/share/file?path=${encodeURIComponent('.hidden')}`, { cookie });
    assert.equal(r.res.status, 403, '隐藏文件未被拦截');
    r = await guestFetch(base, '/api/share/list?path=sub', { cookie });
    assert.equal(r.res.status, 200);
    assert.equal(r.data.entries[0].name, 'b.bin');
    console.log('✓ 共享目录：列表 / 下载 / Range / 越权拦截');

    // ---- 共享单个文件 ----
    const fileShare = await post('/api/settings', { guestShareDir: path.join(shareDir, 'a.txt') });
    assert.equal(fileShare.res.status, 200);
    r = await guestFetch(base, '/api/share/list?path=', { cookie });
    assert.equal(r.res.status, 200);
    assert.equal(r.data.kind, 'file');
    assert.equal(r.data.entries[0].name, 'a.txt');
    r = await guestFetch(base, '/api/share/file?path=', { cookie });
    assert.equal(r.res.status, 200);
    assert.equal(r.data, 'hello guest');
    r = await guestFetch(base, `/api/share/file?path=${encodeURIComponent('sub/b.bin')}`, { cookie });
    assert.equal(r.res.status, 403, '单文件共享时不应允许其他路径');
    await post('/api/settings', { guestShareDir: shareDir });
    console.log('✓ 共享单个文件：只暴露该文件');

    const big = crypto.randomBytes(10 * 1024 * 1024 + 12345);
    const empty = Buffer.alloc(0);
    const batchBody = {
      label: 'folder',
      files: [
        { path: 'folder/big.bin', size: big.length, mtimeMs: 1700000000000 },
        { path: 'folder/empty.txt', size: 0, mtimeMs: 1700000000000 }
      ]
    };
    r = await guestFetch(base, '/api/batches', {
      method: 'POST',
      cookie,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batchBody)
    });
    assert.equal(r.res.status, 200, JSON.stringify(r.data));
    const batch = r.data;
    assert.equal(batch.chunkSize, CHUNK);
    assert.equal(batch.files.length, 2);
    const bigFile = batch.files.find((f) => f.path === 'folder/big.bin');
    const emptyFile = batch.files.find((f) => f.path === 'folder/empty.txt');
    assert.equal(bigFile.chunks, Math.ceil(big.length / CHUNK));
    assert.equal(emptyFile.finished, true, '空文件未直接完成');

    for (let idx = 0; idx < bigFile.chunks; idx++) {
      const slice = big.subarray(idx * CHUNK, (idx + 1) * CHUNK);
      const up = await guestFetch(base, `/api/batches/${batch.batch.id}/files/${bigFile.id}/chunks/${idx}`, {
        method: 'PUT',
        cookie,
        headers: { 'Content-Type': 'application/octet-stream' },
        body: slice
      });
      assert.equal(up.res.status, 200, JSON.stringify(up.data));
      assert.equal(up.data.received, idx + 1);
    }
    r = await guestFetch(base, `/api/batches/${batch.batch.id}/files/${bigFile.id}/finish`, {
      method: 'POST', cookie
    });
    assert.equal(r.res.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.complete, true, '批次未自动完成');
    const received = path.join(downloadDir, '访客上传', 'folder', 'big.bin');
    assert.equal(await sha256File(received), sha256(big), '文件内容不一致');
    const receivedMtime = (await fsp.stat(received)).mtimeMs;
    assert.ok(receivedMtime > Date.now() - 120000 && receivedMtime <= Date.now(), '落盘文件应使用接收时间作为修改日期');
    assert.equal((await fsp.stat(path.join(downloadDir, '访客上传', 'folder', 'empty.txt'))).size, 0);
    assert.equal(fs.existsSync(received + '.lanlink-part'), false, '临时文件未清理');
    assert.equal(fs.existsSync(received + '.lanlink-part.json'), false, 'sidecar 未清理');
    state = await (await fetch(`${host}/api/state`)).json();
    const history = state.history.find((h) => h.id === batch.batch.id);
    assert.ok(history, '历史记录缺少访客上传');
    assert.equal(history.guest, true);
    assert.equal(history.status, 'completed');
    console.log('✓ 分块上传、空文件、SHA-256 校验与历史记录');

    r = await guestFetch(base, '/api/batches', {
      method: 'POST',
      cookie,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [{ path: '../escape.txt', size: 1 }] })
    });
    assert.equal(r.res.status, 400, '路径穿越未被拒绝');
    r = await guestFetch(base, '/api/batches', {
      method: 'POST',
      cookie,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [{ path: 'too-large.bin', size: 101 * 1024 * 1024 }] })
    });
    assert.equal(r.res.status, 413, '单文件配额未生效');
    console.log('✓ 路径穿越与单文件配额被拒绝');

    const resumeData = crypto.randomBytes(9 * 1024 * 1024 + 77);
    const resumeBody = {
      files: [{ path: 'resume.bin', size: resumeData.length, mtimeMs: 1700000001000 }]
    };
    r = await guestFetch(base, '/api/batches', {
      method: 'POST', cookie,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(resumeBody)
    });
    const first = r.data;
    const firstFile = first.files[0];
    const firstChunk = resumeData.subarray(0, CHUNK);
    const up1 = await guestFetch(base, `/api/batches/${first.batch.id}/files/${firstFile.id}/chunks/0`, {
      method: 'PUT', cookie, body: firstChunk
    });
    assert.equal(up1.res.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 1600));
    let interrupted = await guestFetch(base, `/api/batches/${first.batch.id}/cancel`, { method: 'POST', cookie });
    assert.equal(interrupted.res.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 150));

    r = await guestFetch(base, '/api/batches', {
      method: 'POST', cookie,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(resumeBody)
    });
    assert.equal(r.res.status, 200, JSON.stringify(r.data));
    const second = r.data;
    const secondFile = second.files[0];
    assert.deepEqual(secondFile.done, [0], '续传未识别已完成分块');
    for (let idx = 1; idx < secondFile.chunks; idx++) {
      const slice = resumeData.subarray(idx * CHUNK, (idx + 1) * CHUNK);
      const up = await guestFetch(base, `/api/batches/${second.batch.id}/files/${secondFile.id}/chunks/${idx}`, {
        method: 'PUT', cookie, body: slice
      });
      assert.equal(up.res.status, 200, JSON.stringify(up.data));
    }
    r = await guestFetch(base, `/api/batches/${second.batch.id}/files/${secondFile.id}/finish`, {
      method: 'POST', cookie
    });
    assert.equal(r.res.status, 200, JSON.stringify(r.data));
    assert.equal(await sha256File(path.join(downloadDir, '访客上传', 'resume.bin')), sha256(resumeData));
    console.log('✓ 中断后续传仅补传缺失分块');

    const cancelData = crypto.randomBytes(5 * 1024 * 1024);
    r = await guestFetch(base, '/api/batches', {
      method: 'POST', cookie,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [{ path: 'host-cancel.bin', size: cancelData.length }] })
    });
    const cancelBatch = r.data;
    const cancelFile = cancelBatch.files[0];
    const cancelUp = await guestFetch(base, `/api/batches/${cancelBatch.batch.id}/files/${cancelFile.id}/chunks/0`, {
      method: 'PUT', cookie, body: cancelData.subarray(0, CHUNK)
    });
    assert.equal(cancelUp.res.status, 200);
    const hostCancel = await post(`/api/transfers/${cancelBatch.batch.id}/cancel`, {});
    assert.equal(hostCancel.res.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (cancelFile.chunks > 1) {
      const rejected = await guestFetch(base, `/api/batches/${cancelBatch.batch.id}/files/${cancelFile.id}/chunks/1`, {
        method: 'PUT', cookie, body: cancelData.subarray(CHUNK, 2 * CHUNK)
      });
      assert.equal(rejected.res.status, 409, '主机取消后仍可继续上传');
    }
    state = await (await fetch(`${host}/api/state`)).json();
    const canceledEntry = state.history.find((h) => h.id === cancelBatch.batch.id);
    assert.equal(canceledEntry.status, 'canceled');
    console.log('✓ 主机取消上传后访客被拒绝');

    const rotated = await post('/api/guest/rotate', {});
    assert.equal(rotated.res.status, 200);
    assert.notEqual(rotated.data.code, state.guest.code);
    const oldPage = await fetch(`${parsed.origin}/u/${token}`);
    assert.equal(oldPage.status, 404, '旧链接在轮换后仍可访问');
    const oldSession = await guestFetch(base, '/api/info', { cookie });
    assert.equal(oldSession.res.status, 404);
    console.log('✓ 轮换链接与访问码后旧令牌失效');

    state = await (await fetch(`${host}/api/state`)).json();
    const newBase = new URL(state.guest.urls[0]);
    const infoRes = await fetch(`${newBase.origin}/u/${newBase.pathname.split('/').pop()}`);
    assert.equal(infoRes.status, 200, '新链接页面不可用');
    console.log('✓ 新链接仍可打开访客页');

    const disabled = await post('/api/settings', { guestEnabled: false });
    assert.equal(disabled.res.status, 200);
    state = await (await fetch(`${host}/api/state`)).json();
    assert.equal(state.guest.running, false, '关闭后监听仍在运行');
    await assert.rejects(fetch(`${newBase.origin}/`, { signal: AbortSignal.timeout(1000) }));
    console.log('✓ 关闭访客上传后端口停止监听');

    console.log('\n访客上传测试全部通过');
  } finally {
    await app.close().catch(() => {});
    if (!process.env.LANLINK_KEEP) {
      await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    } else {
      console.log(`测试数据保留在: ${root}`);
    }
  }
}

const watchdog = setTimeout(() => {
  console.error('访客测试超时');
  process.exit(1);
}, 180000);
watchdog.unref?.();

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n访客测试失败：');
    console.error(err.stack || err.message);
    process.exit(1);
  });
