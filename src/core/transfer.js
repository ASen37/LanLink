'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const {
  pieceSizeFor,
  hashFileChunks,
  walkPaths,
  safeJoin,
  pathExists,
  timestampSlug,
  freeSpace,
  randHex
} = require('./util');

const WINDOW = 8;
const MAX_RETRIES = 4;

function conflictPath(file) {
  const dir = path.dirname(file);
  const ext = path.extname(file);
  const base = path.basename(file, ext);
  const stamp = timestampSlug().replace('_', ' ');
  let candidate = path.join(dir, `${base} (conflict copy ${stamp})${ext}`);
  let i = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (conflict copy ${stamp} ${i})${ext}`);
    i++;
  }
  return candidate;
}

async function archiveExisting(destRoot, finalPath, relPath, archiveEnabled) {
  if (!(await pathExists(finalPath))) return null;
  if (archiveEnabled) {
    const archiveRoot = path.join(destRoot, '.lanlink-archive', timestampSlug());
    const target = safeJoin(archiveRoot, relPath);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    try {
      await fsp.rename(finalPath, target);
    } catch (err) {
      if (err.code !== 'EXDEV') throw err;
      await fsp.copyFile(finalPath, target);
      await fsp.unlink(finalPath);
    }
    return { type: 'archive', path: target };
  }
  const target = conflictPath(finalPath);
  await fsp.rename(finalPath, target);
  return { type: 'conflict', path: target };
}

class TransferSender {
  constructor(manager, transfer, inputs) {
    this.manager = manager;
    this.transfer = transfer;
    this.inputs = inputs;
    this.session = null;
    this.channel = null;
    this.manifest = null;
    this.files = [];
    this.filePos = 0;
    this.current = null;
    this.state = null;
    this.canceled = false;
    this.offered = false;
    this.done = false;
  }

  async prepare() {
    const t = this.transfer;
    t.status = 'preparing';
    t.startedAt = Date.now();
    this.manager.emitState();

    let inputs = this.inputs.map((p) => path.resolve(p));
    if (!inputs.length) throw new Error('没有选择要发送的文件');

    const single = inputs.length === 1 ? await fsp.stat(inputs[0]) : null;
    let rootLabel;
    if (single && single.isDirectory()) rootLabel = path.basename(inputs[0]);
    else if (single && single.isFile()) rootLabel = path.basename(inputs[0]);
    else rootLabel = `LanLink_${timestampSlug()}`;
    t.rootLabel = rootLabel;
    this.manifestRoot = rootLabel;

    let entries = await walkPaths(inputs, (scanned) => {
      t.preparedBytes = scanned;
      t.preparedTotal = scanned;
    });

    if (inputs.length > 1) {
      entries = entries.map((e) => ({ ...e, path: `${rootLabel}/${e.path}` }));
    }
    const seen = new Set();
    for (const e of entries) {
      if (seen.has(e.path)) throw new Error(`重复的文件路径: ${e.path}`);
      seen.add(e.path);
    }

    const files = entries.filter((e) => e.type === 'file');
    let hashed = 0;
    const total = files.reduce((sum, f) => sum + f.size, 0);
    t.totalBytes = total;
    t.totalFiles = files.length;
    t.preparedBytes = 0;
    t.preparedTotal = total;
    this.manager.emitState();

    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const index = cursor++;
        if (index >= files.length) return;
        const item = files[index];
        if (this.canceled) return;
        const pieceSize = pieceSizeFor(item.size);
        const before = hashed;
        const result = await hashFileChunks(item.absPath, pieceSize, (done) => {
          t.preparedBytes = before + done;
          t.preparedTotal = total;
        });
        Object.assign(item, {
          pieceSize: result.pieceSize,
          chunks: result.chunks,
          treeHash: result.treeHash
        });
        hashed += item.size;
        t.preparedBytes = hashed;
        this.manager.emitState();
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, Math.max(1, files.length)) }, worker));
    if (this.canceled) throw new Error('已取消');

    this.files = entries
      .map((entry, idx) => ({ ...entry, idx }))
      .filter((entry) => entry.type === 'file');

    this.manifest = {
      rootLabel,
      totalBytes: total,
      totalFiles: files.length,
      items: entries.map((e) => ({
        path: e.path.replace(/\\/g, '/'),
        type: e.type,
        size: e.size || 0,
        mtimeMs: e.mtimeMs || 0,
        pieceSize: e.pieceSize || 0,
        chunks: e.chunks || undefined,
        treeHash: e.treeHash || undefined
      }))
    };
    this.transfer.items = this.manifest.items;
    t.preparedTotal = total;
    t.preparedBytes = total;
    this.manager.emitState();
  }

  async attach(session) {
    this.session = session;
    this.channel = session.channel;
    this.transfer.status = 'waiting';
  }

  async sendOffer() {
    if (this.offered) return;
    if (!this.channel) throw new Error('尚未连接');
    this.offered = true;
    await this.channel.send({
      t: 'offer',
      id: this.transfer.id,
      rootLabel: this.manifest.rootLabel,
      totalBytes: this.manifest.totalBytes,
      totalFiles: this.manifest.totalFiles,
      items: this.manifest.items
    });
    this.transfer.status = 'waiting';
    this.manager.emitState();
  }

  begin() {
    if (this.done) return;
    const t = this.transfer;
    t.status = 'transferring';
    t.startedAt = t.startedAt || Date.now();
    t.bytes = t.bytes || 0;
    this.manager.emitState();
    this.nextFile();
  }

  async nextFile() {
    if (this.canceled || this.done) return;
    const t = this.transfer;
    if (this.filePos >= this.files.length) {
      t.status = 'finishing';
      this.manager.emitState();
      return;
    }
    const file = this.files[this.filePos];
    this.current = file;
    t.currentFile = file.path;
    this.state = {
      fh: null,
      acked: new Set(),
      inFlight: new Set(),
      queue: [],
      retries: new Map(),
      total: file.chunks.length
    };
    try {
      await this.channel.send({ t: 'file_start', i: file.idx });
    } catch (err) {
      this.fail(err);
    }
  }

  async onNeed(i, list) {
    if (this.canceled || !this.current || this.current.idx !== i) return;
    const state = this.state;
    if (!state.fh) {
      state.fh = await fsp.open(this.current.absPath, 'r');
    }
    state.queue.push(...list.filter((idx) => !state.acked.has(idx) && !state.inFlight.has(idx)));
    this.pump();
  }

  async pump() {
    const state = this.state;
    if (!state || state.pumping || this.canceled) return;
    state.pumping = true;
    try {
      while (state.queue.length && state.inFlight.size < WINDOW && !this.canceled) {
        const idx = state.queue.shift();
        if (state.acked.has(idx) || state.inFlight.has(idx)) continue;
        state.inFlight.add(idx);
        const file = this.current;
        const offset = idx * file.pieceSize;
        const len = Math.min(file.pieceSize, file.size - offset);
        const buf = Buffer.allocUnsafe(len);
        const { bytesRead } = await state.fh.read(buf, 0, len, offset);
        if (bytesRead !== len) throw new Error(`读取文件失败: ${file.path}`);
        this.channel
          .sendData({ t: 'chunk', i: file.idx, idx }, buf)
          .catch((err) => this.fail(err));
      }
    } catch (err) {
      this.fail(err);
    } finally {
      if (state) state.pumping = false;
    }
  }

  onFileState(i, haveBytes) {
    if (!this.current || this.current.idx !== i) return;
    if (haveBytes && !this.current.countedBase) {
      this.current.countedBase = true;
      this.transfer.bytes += haveBytes;
      this.transfer.resumedBytes = (this.transfer.resumedBytes || 0) + haveBytes;
      this.manager.emitState();
    }
  }

  onChunkOk(i, idx) {
    this.onChunkOkMany(i, [idx]);
  }

  onChunkOkMany(i, list) {
    const state = this.state;
    if (!state || !this.current || this.current.idx !== i || !Array.isArray(list)) return;
    let changed = false;
    for (const idx of list) {
      if (!Number.isInteger(idx) || !state.inFlight.has(idx)) continue;
      state.inFlight.delete(idx);
      state.acked.add(idx);
      const offset = idx * this.current.pieceSize;
      this.transfer.bytes += Math.min(this.current.pieceSize, this.current.size - offset);
      changed = true;
    }
    if (changed) this.pump();
  }

  onChunkBad(i, idx) {
    const state = this.state;
    if (!state || !this.current || this.current.idx !== i) return;
    state.inFlight.delete(idx);
    const count = (state.retries.get(idx) || 0) + 1;
    state.retries.set(idx, count);
    if (count > MAX_RETRIES) {
      this.fail(new Error(`分块校验失败: ${this.current.path}#${idx}`));
      return;
    }
    state.queue.push(idx);
    this.pump();
  }

  async onFileDone(i, msg) {
    if (!this.current || this.current.idx !== i) return;
    if (this.state.fh) {
      await this.state.fh.close().catch(() => {});
    }
    if (msg && msg.skipped) {
      this.transfer.bytes += this.current.size;
    }
    this.state = null;
    this.current = null;
    this.transfer.filesDone += 1;
    this.manager.emitState();
    this.filePos += 1;
    this.nextFile();
  }

  onRemoteDone() {
    if (this.done) return;
    this.done = true;
    if (this.channel) this.channel.send({ t: 'done_ack' }).catch(() => {});
    this.manager.completeTransfer(this.transfer, 'completed');
  }

  cancel() {
    if (this.done) return;
    this.canceled = true;
    if (this.channel) this.channel.send({ t: 'cancel', id: this.transfer.id }).catch(() => {});
    if (this.state && this.state.fh) this.state.fh.close().catch(() => {});
    this.manager.completeTransfer(this.transfer, 'canceled', '发送方已取消');
  }

  fail(err) {
    if (this.done || this.canceled) return;
    this.done = true;
    this.canceled = true;
    if (this.state && this.state.fh) this.state.fh.close().catch(() => {});
    if (this.channel) this.channel.send({ t: 'cancel', id: this.transfer.id }).catch(() => {});
    this.manager.completeTransfer(this.transfer, 'failed', err.message || String(err));
  }

  abort(reason = '连接中断', status = 'failed') {
    if (this.done) return;
    this.done = true;
    this.canceled = true;
    if (this.state && this.state.fh) this.state.fh.close().catch(() => {});
    this.manager.completeTransfer(this.transfer, status, reason);
  }
}

class TransferReceiver {
  constructor(manager, transfer, offer, destDir, settings) {
    this.manager = manager;
    this.transfer = transfer;
    this.offer = offer;
    this.destDir = destDir;
    this.settings = settings;
    this.channel = transfer.session.channel;
    this.current = null;
    this.filePos = 0;
    this.canceled = false;
    this.done = false;
    this.flushTimer = null;
    this.writeChain = Promise.resolve();
    this.writePending = 0;
    this.pendingAcks = [];
    this.ackScheduled = false;
    this.dirs = new Set();
  }

  async ensureDir(dir) {
    const key = path.resolve(dir);
    if (this.dirs.has(key)) return;
    await fsp.mkdir(key, { recursive: true });
    this.dirs.add(key);
  }

  async start() {
    const t = this.transfer;
    t.destDir = this.destDir;
    await this.ensureDir(this.destDir);
    const free = await freeSpace(this.destDir);
    if (free !== null && free < this.offer.totalBytes + 16 * 1024 * 1024) {
      throw new Error(`目标磁盘空间不足，需要 ${Math.ceil(this.offer.totalBytes / 1048576)} MB`);
    }
    for (const item of this.offer.items) {
      if (item.type === 'dir') {
        await this.ensureDir(safeJoin(this.destDir, item.path));
      }
    }
    t.status = 'transferring';
    t.startedAt = Date.now();
    await this.channel.send({ t: 'offer_accept', id: this.offer.id, destDir: this.destDir });
    this.manager.emitState();
  }

  async onFileStart(i) {
    if (this.canceled) return;
    const item = this.offer.items[i];
    if (!item) return;
    const claim = await this.manager.destinations.claim(this.destDir, item.path, this.transfer.id);
    const finalPath = claim.finalPath;
    const ownerTag = String(this.transfer.peer && this.transfer.peer.id ? this.transfer.peer.id : 'unknown').slice(0, 8);
    await this.ensureDir(path.dirname(finalPath));
    this.current = {
      i,
      item,
      finalPath,
      claimKey: claim.key,
      partPath: `${finalPath}.${ownerTag}.lanlink-part`,
      sidecarPath: `${finalPath}.${ownerTag}.lanlink-part.json`,
      done: new Set(),
      fh: null,
      baseBytes: 0,
      existing: null
    };
    if (claim.renamed) {
      item.path = path.relative(this.destDir, finalPath).split(path.sep).join('/');
      if (this.offer.totalFiles === 1) this.transfer.rootLabel = path.basename(finalPath);
      this.manager.toast(`检测到同名文件，已保存为 ${path.basename(finalPath)}`, 'info');
    }
    const t = this.transfer;
    t.currentFile = item.path;
    this.manager.emitState();

    let existingStat = null;
    try { existingStat = await fsp.stat(finalPath); } catch { /* missing */ }
    if (existingStat && existingStat.isFile()) {
      if (existingStat.size === item.size && Math.abs(existingStat.mtimeMs - item.mtimeMs) < 2000) {
        await this.skipFile();
        return;
      }
      if (existingStat.size === item.size && item.treeHash) {
        t.status = 'transferring';
        try {
          const currentHash = await hashFileChunks(finalPath, item.pieceSize);
          if (currentHash.treeHash === item.treeHash) {
            await this.skipFile();
            return;
          }
        } catch { /* fall through to transfer */ }
      }
      this.current.existing = true;
    }

    // 兼容旧版本固定后缀的断点文件
    if (!(await pathExists(this.current.sidecarPath))) {
      const legacyPart = `${finalPath}.lanlink-part`;
      const legacySide = `${legacyPart}.json`;
      if (await pathExists(legacyPart) && await pathExists(legacySide)) {
        try {
          await fsp.rename(legacyPart, this.current.partPath);
          await fsp.rename(legacySide, this.current.sidecarPath);
        } catch { /* 迁移失败则按新任务处理 */ }
      }
    }

    let done = new Set();
    let sidecar = null;
    try {
      sidecar = JSON.parse(await fsp.readFile(this.current.sidecarPath, 'utf8'));
    } catch { /* no resumable state */ }

    let partHandle = null;
    if (sidecar) {
      const age = Date.now() - new Date(sidecar.updatedAt || 0).getTime();
      const ttl = (this.settings.partialTtlHours || 24) * 3600 * 1000;
      if (sidecar.treeHash === item.treeHash && sidecar.size === item.size && (ttl <= 0 || age < ttl)) {
        try {
          partHandle = await fsp.open(this.current.partPath, 'r+');
          const partStat = await partHandle.stat();
          if (partStat.size === item.size) {
            done = new Set(sidecar.done || []);
            this.current.hasSidecar = true;
          } else {
            await partHandle.close();
            partHandle = null;
          }
        } catch {
          partHandle = null;
        }
      }
    }
    if (!partHandle) {
      if (sidecar) await fsp.rm(this.current.sidecarPath, { force: true }).catch(() => {});
      partHandle = await fsp.open(this.current.partPath, 'w+');
    }
    this.current.done = done;
    this.current.fh = partHandle;

    let baseBytes = 0;
    for (const idx of done) {
      const off = idx * item.pieceSize;
      baseBytes += Math.min(item.pieceSize, item.size - off);
    }
    this.current.baseBytes = baseBytes;
    t.bytes += baseBytes;
    t.resumedBytes = (t.resumedBytes || 0) + baseBytes;

    const missing = [];
    for (let idx = 0; idx < item.chunks.length; idx++) {
      if (!done.has(idx)) missing.push(idx);
    }
    if (!missing.length) {
      await this.finalize();
      return;
    }
    if (baseBytes > 0) await this.channel.send({ t: 'file_state', i, haveBytes: baseBytes });
    await this.channel.send({ t: 'need', i, list: missing });
    this.manager.emitState();
  }

  async skipFile() {
    const cur = this.current;
    const t = this.transfer;
    t.bytes += cur.item.size;
    t.filesDone += 1;
    await this.channel.send({ t: 'file_done', i: cur.i, skipped: true, path: cur.finalPath });
    if (cur.claimKey) this.manager.destinations.releasePath(cur.claimKey, this.transfer.id);
    this.current = null;
    await this.maybeFinish();
  }

  onChunk(header, body) {
    if (this.canceled || !this.current || header.i !== this.current.i) return;
    const cur = this.current;
    const idx = header.idx;
    if (!Number.isInteger(idx) || idx < 0 || idx >= cur.item.chunks.length) return;
    this.writePending += 1;
    const task = this.writeChain.then(async () => {
      if (this.canceled || !this.current || this.current !== cur) return;
      if (cur.done.has(idx)) {
        this.queueAck(cur.i, idx);
        return;
      }
      const offset = idx * cur.item.pieceSize;
      const expected = Math.min(cur.item.pieceSize, cur.item.size - offset);
      if (body.length !== expected) {
        await this.channel.send({ t: 'chunk_bad', i: cur.i, idx });
        return;
      }
      const digest = crypto.createHash('sha256').update(body).digest('hex');
      if (digest !== cur.item.chunks[idx]) {
        await this.channel.send({ t: 'chunk_bad', i: cur.i, idx });
        return;
      }
      await cur.fh.write(body, 0, body.length, offset);
      cur.done.add(idx);
      this.transfer.bytes += body.length;
      this.queueAck(cur.i, idx);
      this.scheduleFlush();
      if (cur.done.size === cur.item.chunks.length) {
        await this.flushAcks();
        await this.finalize();
      }
    });
    this.writeChain = task
      .catch((err) => this.fail(err))
      .finally(() => {
        this.writePending -= 1;
        if (this.writePending === 0) this.flushAcks().catch((err) => this.fail(err));
      });
  }

  queueAck(i, idx) {
    this.pendingAcks.push({ i, idx });
    if (this.ackScheduled) return;
    this.ackScheduled = true;
    setImmediate(() => {
      this.ackScheduled = false;
      if (this.writePending > 0) return;
      this.flushAcks().catch((err) => this.fail(err));
    });
  }

  async flushAcks() {
    if (!this.pendingAcks.length) return;
    const batch = this.pendingAcks;
    this.pendingAcks = [];
    const byFile = new Map();
    for (const { i, idx } of batch) {
      let list = byFile.get(i);
      if (!list) byFile.set(i, (list = []));
      list.push(idx);
    }
    for (const [i, list] of byFile) {
      if (list.length === 1) await this.channel.send({ t: 'chunk_ok', i, idx: list[0] });
      else await this.channel.send({ t: 'chunk_ok_many', i, list });
    }
  }

  scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushSidecar().catch(() => {});
    }, 1500);
  }

  async flushSidecar() {
    const cur = this.current;
    if (!cur || !cur.fh || !cur.item.treeHash) return;
    const payload = {
      treeHash: cur.item.treeHash,
      size: cur.item.size,
      done: [...cur.done],
      updatedAt: new Date().toISOString()
    };
    cur.hasSidecar = true;
    await fsp.writeFile(cur.sidecarPath, JSON.stringify(payload)).catch(() => {});
  }

  async finalize() {
    const cur = this.current;
    if (!cur || !cur.fh) return;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await cur.fh.close().catch(() => {});
    cur.fh = null;

    let archived = null;
    await this.manager.destinations.withPathLock(cur.claimKey, async () => {
      if (await pathExists(cur.finalPath)) {
        archived = await archiveExisting(this.destDir, cur.finalPath, cur.item.path, this.settings.archiveEnabled !== false);
      }
      try {
        await fsp.rename(cur.partPath, cur.finalPath);
      } catch (err) {
        if (await pathExists(cur.finalPath)) {
          await archiveExisting(this.destDir, cur.finalPath, cur.item.path, this.settings.archiveEnabled !== false);
          await fsp.rename(cur.partPath, cur.finalPath);
        } else {
          throw err;
        }
      }
    });
    if (cur.claimKey) this.manager.destinations.releasePath(cur.claimKey, this.transfer.id);
    if (cur.hasSidecar) await fsp.rm(cur.sidecarPath, { force: true });
    this.transfer.filesDone += 1;
    await this.channel.send({ t: 'file_done', i: cur.i, path: cur.finalPath, archived: archived ? archived.type : null });
    if (archived) {
      this.manager.toast(
        archived.type === 'archive' ? `旧版本已移入归档: ${path.basename(archived.path)}` : `已生成冲突副本: ${path.basename(archived.path)}`,
        'info'
      );
    }
    this.current = null;
    await this.maybeFinish();
  }

  async maybeFinish() {
    const t = this.transfer;
    this.manager.emitState();
    if (t.filesDone >= this.offer.totalFiles && !this.done) {
      this.done = true;
      await this.channel.send({ t: 'done', id: t.id }).catch(() => {});
      this.manager.completeTransfer(t, 'completed');
    }
  }

  cancel() {
    if (this.done) return;
    this.canceled = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.current && this.current.fh) {
      this.flushSidecar().catch(() => {});
      this.current.fh.close().catch(() => {});
    }
    if (this.channel) this.channel.send({ t: 'cancel', id: this.transfer.id }).catch(() => {});
    this.manager.completeTransfer(this.transfer, 'canceled', '接收方已取消');
  }

  fail(err) {
    if (this.done) return;
    this.done = true;
    this.canceled = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.current && this.current.fh) {
      this.flushSidecar().catch(() => {});
      this.current.fh.close().catch(() => {});
    }
    this.manager.completeTransfer(this.transfer, 'failed', err.message || String(err));
  }

  abort(reason = '连接中断', status = 'failed') {
    if (this.done) return;
    this.done = true;
    this.canceled = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.current && this.current.fh) {
      this.flushSidecar().catch(() => {});
      this.current.fh.close().catch(() => {});
    }
    this.manager.completeTransfer(this.transfer, status, reason);
  }
}

module.exports = { TransferSender, TransferReceiver, archiveExisting, conflictPath };
