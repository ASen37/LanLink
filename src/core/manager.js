'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const { Identity, defaultDeviceName } = require('./identity');
const { connect, accept } = require('./channel');
const { Discovery } = require('./discovery');
const { TransferSender, TransferReceiver } = require('./transfer');
const { GuestServer, INBOX_NAME } = require('./guest');
const { randHex } = require('./util');

const ACTIVE = new Set(['preparing', 'pairing', 'waiting', 'transferring', 'finishing', 'starting']);

class PairingRequired extends Error {
  constructor(session) {
    super('需要配对');
    this.code = 'PAIRING';
    this.session = session;
  }
}

function atomicWrite(file, data) {
  const tmp = file + '.tmp';
  return fsp.writeFile(tmp, data).then(() => fsp.rename(tmp, file));
}

class Manager extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.dataDir = path.resolve(opts.dataDir || path.join(os.homedir(), '.lanlink'));
    this.identity = null;
    this.settings = {
      deviceName: opts.name || '',
      downloadDir: path.join(os.homedir(), 'Downloads', 'LanLink'),
      autoAccept: false,
      archiveEnabled: true,
      partialTtlHours: 24,
      discoveryEnabled: opts.discovery !== false,
      guestEnabled: false,
      guestPort: 7420,
      guestExpiryHours: 12,
      guestMaxFileMB: 4096,
      guestMaxBatchMB: 20480,
      guestToken: '',
      guestCode: '',
      guestExpiresAt: 0
    };
    this.trusted = new Map();
    this.peers = new Map();
    this.sessions = new Map();
    this.transfers = new Map();
    this.offers = new Map();
    this.pairRequests = new Map();
    this.pendingOut = new Map();
    this.history = [];
    this.tcpServer = null;
    this.discovery = null;
    this.guest = null;
    this.guestExpiring = false;
    this.uiPort = opts.uiPort;
    this.tcpPort = opts.tcpPort;
    this.discoveryPort = opts.discoveryPort ?? 7412;
    this.autoTrust = Boolean(opts.autoTrust);
    this.ticker = null;
    this.startedAt = Date.now();
  }

  async start() {
    await fsp.mkdir(this.dataDir, { recursive: true });
    this.identity = await Identity.load(this.dataDir, this.opts.name || this.settings.deviceName || defaultDeviceName());
    if (this.opts.name && this.opts.name !== this.identity.name) {
      await this.identity.rename(this.opts.name);
    }
    await this.loadSettings();
    await this.normalizeGuestSettings();
    if (this.settings.deviceName && this.settings.deviceName !== this.identity.name) {
      await this.identity.rename(this.settings.deviceName);
    }
    await this.loadTrusted();
    await this.loadHistory();

    await this.startTcp();
    if (this.settings.discoveryEnabled) this.startDiscovery();
    await this.applyGuest({ announce: false });
    this.ticker = setInterval(() => this.onTick(), 1000);
    this.ticker.unref?.();
  }

  async normalizeGuestSettings() {
    const s = this.settings;
    s.guestEnabled = Boolean(s.guestEnabled);
    const port = Number(s.guestPort);
    s.guestPort = Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 7420;
    const hours = Number(s.guestExpiryHours);
    s.guestExpiryHours = Number.isFinite(hours) ? Math.max(0, Math.min(720, hours)) : 12;
    const maxFile = Number(s.guestMaxFileMB);
    s.guestMaxFileMB = Number.isFinite(maxFile) ? Math.max(1, Math.min(1048576, maxFile)) : 4096;
    const maxBatch = Number(s.guestMaxBatchMB);
    s.guestMaxBatchMB = Number.isFinite(maxBatch) ? Math.max(1, Math.min(1048576, maxBatch)) : 20480;
    if (!/^[0-9a-f]{32}$/.test(String(s.guestToken || ''))) s.guestToken = randHex(16);
    if (!/^\d{6}$/.test(String(s.guestCode || ''))) s.guestCode = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const expiresAt = Number(s.guestExpiresAt);
    s.guestExpiresAt = Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : 0;
    await this.saveSettings();
  }

  async loadSettings() {
    try {
      const raw = JSON.parse(await fsp.readFile(path.join(this.dataDir, 'settings.json'), 'utf8'));
      Object.assign(this.settings, raw);
    } catch { /* defaults */ }
  }

  async saveSettings() {
    await atomicWrite(path.join(this.dataDir, 'settings.json'), JSON.stringify(this.settings, null, 2));
  }

  async loadTrusted() {
    try {
      const raw = JSON.parse(await fsp.readFile(path.join(this.dataDir, 'trusted.json'), 'utf8'));
      for (const entry of raw) {
        this.trusted.set(entry.id, entry);
        this.peers.set(entry.id, {
          id: entry.id,
          name: entry.name,
          fingerprint: entry.fingerprint,
          host: entry.lastHost,
          tcpPort: entry.lastPort,
          trusted: true,
          source: 'trusted',
          lastSeen: 0,
          online: false
        });
      }
    } catch { /* none */ }
  }

  async persistTrusted() {
    await atomicWrite(path.join(this.dataDir, 'trusted.json'), JSON.stringify([...this.trusted.values()], null, 2));
  }

  async loadHistory() {
    try {
      this.history = JSON.parse(await fsp.readFile(path.join(this.dataDir, 'history.json'), 'utf8'));
    } catch {
      this.history = [];
    }
  }

  async persistHistory() {
    await atomicWrite(path.join(this.dataDir, 'history.json'), JSON.stringify(this.history.slice(0, 200), null, 2));
  }

  async startTcp() {
    this.tcpServer = net.createServer((socket) => this.handleSocket(socket));
    const listen = (port, attempts) => new Promise((resolve, reject) => {
      const onError = (err) => {
        this.tcpServer.off('listening', onListening);
        if (err.code === 'EADDRINUSE' && attempts > 0) {
          listen(port + 1, attempts - 1).then(resolve, reject);
        } else if (err.code === 'EADDRINUSE' && port !== 0) {
          listen(0, 0).then(resolve, reject);
        } else {
          reject(err);
        }
      };
      const onListening = () => {
        this.tcpServer.off('error', onError);
        this.tcpPort = this.tcpServer.address().port;
        resolve();
      };
      this.tcpServer.once('error', onError);
      this.tcpServer.once('listening', onListening);
      this.tcpServer.listen(port, '0.0.0.0');
    });
    await listen(this.opts.tcpPort ?? 7411, 5);
  }

  setUiPort(port) {
    this.uiPort = port;
    if (this.discovery) this.discovery.update({ tcpPort: this.tcpPort, uiPort: port });
  }

  async applyGuest({ announce = true } = {}) {
    if (!this.identity) return;
    const s = this.settings;
    if (!s.guestEnabled) {
      const g = this.guest;
      this.guest = null;
      if (g) await g.stop();
      return;
    }
    if (s.guestExpiresAt && Date.now() > s.guestExpiresAt) {
      s.guestEnabled = false;
      s.guestExpiresAt = 0;
      await this.saveSettings();
      const g = this.guest;
      this.guest = null;
      if (g) await g.stop();
      if (announce) this.toast('访客上传链接已过期，服务已关闭', 'info');
      this.emitState();
      return;
    }
    if (!s.guestExpiresAt && s.guestExpiryHours > 0) {
      s.guestExpiresAt = Date.now() + s.guestExpiryHours * 3600 * 1000;
      await this.saveSettings();
    }
    if (!this.guest) {
      this.guest = new GuestServer({
        manager: this,
        uiDir: this.opts.uiDir,
        onLog: (msg) => this.opts.log?.(msg)
      });
    }
    try {
      await this.guest.start(s.guestPort);
      if (announce) this.toast(`访客上传已开启，端口 ${this.guest.port}`, 'success');
    } catch (err) {
      if (announce) this.toast(this.guest.lastError || `访客上传启动失败：${err.message}`, 'error');
      this.opts.log?.(`guest server failed: ${err.stack || err.message}`);
    }
    this.emitState();
  }

  async rotateGuestAccess() {
    const s = this.settings;
    s.guestToken = randHex(16);
    s.guestCode = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    if (s.guestEnabled && s.guestExpiryHours > 0) {
      s.guestExpiresAt = Date.now() + s.guestExpiryHours * 3600 * 1000;
    }
    if (this.guest) this.guest.revokeAll('访客访问链接已更新');
    await this.saveSettings();
    this.toast('访客链接与访问码已更新', 'success');
    this.emitState();
    return this.guestInfo();
  }

  guestInfo() {
    const s = this.settings;
    if (this.guest) return this.guest.publicInfo();
    return {
      enabled: Boolean(s.guestEnabled),
      running: false,
      port: Number(s.guestPort) || 0,
      urls: [],
      code: s.guestCode || '',
      expiresAt: s.guestExpiresAt || 0,
      maxFileBytes: (s.guestMaxFileMB || 0) * 1024 * 1024,
      maxBatchBytes: (s.guestMaxBatchMB || 0) * 1024 * 1024,
      inbox: path.join(s.downloadDir, INBOX_NAME),
      error: null
    };
  }

  async expireGuest() {
    if (this.guestExpiring) return;
    this.guestExpiring = true;
    try {
      const s = this.settings;
      s.guestEnabled = false;
      s.guestExpiresAt = 0;
      await this.saveSettings();
      const g = this.guest;
      this.guest = null;
      if (g) await g.stop();
      this.toast('访客上传链接已过期，已自动关闭', 'info');
      this.emitState();
    } finally {
      this.guestExpiring = false;
    }
  }

  startDiscovery() {
    if (this.discovery) return;
    this.discovery = new Discovery({
      identity: this.identity,
      tcpPort: this.tcpPort,
      uiPort: this.uiPort || 0,
      port: this.discoveryPort,
      onPeer: (packet, rinfo) => this.onDiscovered(packet, rinfo),
      onLog: (msg) => this.opts.log?.(msg)
    });
    this.discovery.start();
  }

  onDiscovered(packet, rinfo) {
    if (!packet || packet.v !== 1 || packet.id === this.identity.id) return;
    if (typeof packet.id !== 'string' || packet.id.length > 64) return;
    const existing = this.peers.get(packet.id);
    const trustedEntry = this.trusted.get(packet.id);
    const peer = {
      id: packet.id,
      name: String(packet.name || 'LanLink Device').slice(0, 64),
      fingerprint: typeof packet.fingerprint === 'string' ? packet.fingerprint : existing?.fingerprint,
      host: rinfo.address,
      tcpPort: Number(packet.tcpPort) || existing?.tcpPort,
      uiPort: Number(packet.uiPort) || existing?.uiPort,
      trusted: Boolean(trustedEntry),
      source: existing?.source === 'manual' ? 'manual' : 'lan',
      lastSeen: Date.now(),
      offlineAt: 0,
      online: true
    };
    this.peers.set(packet.id, { ...existing, ...peer });
    this.emitState();
  }

  async handleSocket(socket) {
    try {
      const channel = await accept(socket, this.identity, { tcpPort: this.tcpPort, uiPort: this.uiPort });
      if (channel.peer.id === this.identity.id) {
        channel.close('self connect');
        return;
      }
      this.registerChannel(channel, { incoming: true });
    } catch (err) {
      socket.destroy();
      this.opts.log?.(`handshake rejected: ${err.message}`);
    }
  }

  registerChannel(channel, { incoming, host, port } = {}) {
    const peer = channel.peer;
    const existing = this.sessions.get(peer.id);
    if (existing && existing.channel !== channel) {
      existing.closed = true;
      existing.channel.close('replaced');
    }
    const session = {
      peer,
      channel,
      sas: channel.sas,
      trusted: this.trusted.has(peer.id),
      incoming,
      closed: false,
      outgoing: null,
      incomingTransfer: null
    };
    this.sessions.set(peer.id, session);

    const known = this.peers.get(peer.id) || {};
    this.peers.set(peer.id, {
      ...known,
      id: peer.id,
      name: peer.name,
      fingerprint: peer.fingerprint,
      host: host || known.host || channel.remoteAddress,
      tcpPort: port || peer.tcpPort || known.tcpPort,
      trusted: session.trusted,
      lastSeen: Date.now(),
      online: true,
      source: known.source || 'lan'
    });

    channel.on('message', (msg) => {
      this.onMessage(session, msg).catch((err) => this.onSessionError(session, err));
    });
    channel.on('chunk', (header, body) => {
      try {
        if (session.incomingTransfer && session.incomingTransfer.receiver) {
          session.incomingTransfer.receiver.onChunk(header, body);
        }
      } catch (err) {
        this.onSessionError(session, err);
      }
    });
    channel.on('close', (reason) => this.onSessionClose(session, reason));
    channel.on('error', (err) => this.opts.log?.(`session error: ${err.message}`));

    if (session.trusted) {
      const entry = this.trusted.get(peer.id);
      if (entry) {
        entry.lastHost = this.peers.get(peer.id).host || entry.lastHost;
        entry.lastPort = this.peers.get(peer.id).tcpPort || entry.lastPort;
        entry.name = peer.name;
        this.persistTrusted().catch(() => {});
      }
    } else if (this.autoTrust) {
      this.trustPeer(session, this.peers.get(peer.id).host, this.peers.get(peer.id).tcpPort);
      session.trusted = true;
      channel.send({ t: 'pair_ok' }).catch(() => {});
    }
    channel.send({ t: 'trust_state', trusted: session.trusted }).catch(() => {});
    this.emitState();
    return session;
  }

  onSessionError(session, err) {
    this.opts.log?.(`session message error: ${err.stack || err.message}`);
    this.toast(err.message || '传输会话出错', 'error');
  }

  onSessionClose(session, reason) {
    if (session.closed) return;
    session.closed = true;
    if (this.sessions.get(session.peer.id) === session) this.sessions.delete(session.peer.id);
    this.pairRequests.delete(session.peer.id);
    // 对端主动断开（取消配对/拒绝配对）由各自流程提示；这里只提示非预期断线，
    // 让另一端也能立刻"感受到"连接已经消失。
    const quiet = new Set([
      'user disconnect', 'peer unpaired', 'pairing declined', 'peer mismatch',
      'self connect', 'replaced', 'shutdown'
    ]);
    const abrupt = reason === 'closed' || reason === 'error' || reason === 'local';
    if (!quiet.has(reason) && abrupt) {
      const name = session.peer?.name || '对方设备';
      this.toast(`与 ${name} 的连接已断开`, 'warning');
    }
    // 非预期断线：立刻把对端标成离线，不必等 12 秒的发现窗口过期。
    // 如果对方其实还活着，下一次 UDP 广播（≤2.5 秒）会把 lastSeen 刷新回来。
    if (abrupt && !this.sessions.has(session.peer.id)) {
      const peer = this.peers.get(session.peer.id);
      if (peer) {
        peer.online = false;
        peer.offlineAt = Date.now();
      }
    }
    const t = session.outgoing;
    if (t && ACTIVE.has(t.status)) {
      if (t.sender) t.sender.abort('连接中断');
    }
    const r = session.incomingTransfer;
    if (r && ACTIVE.has(r.status)) {
      if (r.receiver) r.receiver.abort('连接中断，已保留临时文件，可重新发送以续传');
    }
    const p = this.pendingOut.get(session.peer.id);
    if (p && ACTIVE.has(p.status)) {
      this.completeTransfer(p, 'failed', '连接已断开');
      this.pendingOut.delete(session.peer.id);
    }
    this.emitState();
  }

  async onMessage(session, msg) {
    if (!msg || typeof msg.t !== 'string') return;
    switch (msg.t) {
      case 'pair_req': {
        if (session.trusted) {
          await session.channel.send({ t: 'pair_ok' });
          return;
        }
        this.pairRequests.set(session.peer.id, {
          sessionId: session.peer.id,
          peer: session.peer,
          sas: session.sas,
          initiated: false,
          at: Date.now()
        });
        this.toast(`${session.peer.name} 请求配对，验证码 ${session.sas}`, 'info');
        this.emitState();
        if (this.autoTrust) await this.acceptPair(session.peer.id);
        return;
      }
      case 'pair_ok': {
        const pending = this.pairRequests.get(session.peer.id);
        if (!session.trusted) {
          if (!pending || !pending.initiated) return;
          this.trustPeer(session, session.peer.host, session.peer.tcpPort);
          session.trusted = true;
        }
        this.pairRequests.delete(session.peer.id);
        this.toast(`已与 ${session.peer.name} 配对`, 'success');
        this.emitState();
        await this.resumePending(session.peer.id);
        return;
      }
      case 'pair_deny': {
        this.pairRequests.delete(session.peer.id);
        this.toast(`${session.peer.name} 拒绝了配对请求`, 'warning');
        const pending = this.pendingOut.get(session.peer.id);
        if (pending) {
          this.pendingOut.delete(session.peer.id);
          this.completeTransfer(pending, 'failed', '对方拒绝了配对');
        }
        this.emitState();
        return;
      }
      case 'unpair': {
        this.untrustPeer(session.peer.id);
        session.trusted = false;
        this.toast(`${session.peer.name} 已取消配对`, 'info');
        session.channel.close('peer unpaired');
        this.emitState();
        return;
      }
      case 'trust_state': {
        if (msg.trusted === false && (session.trusted || this.trusted.has(session.peer.id))) {
          this.untrustPeer(session.peer.id);
          session.trusted = false;
          this.peers.set(session.peer.id, { ...this.peers.get(session.peer.id), trusted: false });
          this.toast(`${session.peer.name} 已取消配对`, 'info');
          this.emitState();
        }
        return;
      }
      case 'ping':
      case 'pong':
        return;
      default:
        break;
    }

    if (!session.trusted) {
      await session.channel.send({ t: 'error', reason: 'pairing_required' }).catch(() => {});
      return;
    }

    switch (msg.t) {
      case 'offer': {
        if (typeof msg.id !== 'string' || !/^[0-9a-f]{8,64}$/i.test(msg.id)) return;
        if (!Number.isFinite(msg.totalBytes) || msg.totalBytes < 0 || msg.totalBytes > 8 * 1024 ** 4) return;
        if (!Array.isArray(msg.items) || msg.items.length > 500000) return;
        if (session.incomingTransfer && ACTIVE.has(session.incomingTransfer.status)) {
          await session.channel.send({ t: 'offer_reject', id: msg.id, reason: 'busy' });
          return;
        }
        this.offers.set(msg.id, {
          id: msg.id,
          sessionId: session.peer.id,
          peer: session.peer,
          rootLabel: String(msg.rootLabel || 'Transfer').slice(0, 200),
          totalBytes: Number(msg.totalBytes) || 0,
          totalFiles: Number(msg.totalFiles) || 0,
          items: Array.isArray(msg.items) ? msg.items : [],
          receivedAt: Date.now()
        });
        this.toast(`${session.peer.name} 想要发送“${msg.rootLabel}”`, 'info');
        this.emitState();
        if (this.settings.autoAccept) {
          await this.acceptIncoming(msg.id, this.settings.downloadDir);
        }
        return;
      }
      case 'offer_accept': {
        const t = session.outgoing;
        if (!t || t.id !== msg.id) return;
        if (t.sender) t.sender.begin();
        return;
      }
      case 'offer_reject': {
        const t = session.outgoing;
        if (!t || t.id !== msg.id) return;
        this.completeTransfer(t, 'failed', msg.reason === 'busy' ? '对方正忙' : '对方拒绝了传输');
        return;
      }
      case 'file_start':
        if (session.incomingTransfer?.receiver) await session.incomingTransfer.receiver.onFileStart(msg.i);
        return;
      case 'need':
        if (session.outgoing?.sender) await session.outgoing.sender.onNeed(msg.i, msg.list || []);
        return;
      case 'file_state':
        if (session.outgoing?.sender) session.outgoing.sender.onFileState(msg.i, Number(msg.haveBytes) || 0);
        return;
      case 'chunk_ok':
        if (session.outgoing?.sender) session.outgoing.sender.onChunkOk(msg.i, msg.idx);
        return;
      case 'chunk_ok_many':
        if (Array.isArray(msg.list) && msg.list.length <= 100000) {
          if (session.outgoing?.sender) session.outgoing.sender.onChunkOkMany(msg.i, msg.list);
        }
        return;
      case 'chunk_bad':
        if (session.outgoing?.sender) session.outgoing.sender.onChunkBad(msg.i, msg.idx);
        return;
      case 'file_done':
        if (session.outgoing?.sender) await session.outgoing.sender.onFileDone(msg.i, msg);
        return;
      case 'done':
        if (session.outgoing?.sender) session.outgoing.sender.onRemoteDone();
        if (session.incomingTransfer?.receiver) session.incomingTransfer.receiver.onRemoteDone?.();
        return;
      case 'done_ack':
        return;
      case 'cancel': {
        const out = session.outgoing;
        if (out && ACTIVE.has(out.status) && out.sender) out.sender.abort('对方取消了传输', 'canceled');
        const inc = session.incomingTransfer;
        if (inc && ACTIVE.has(inc.status) && inc.receiver) inc.receiver.abort('对方取消了传输', 'canceled');
        return;
      }
      case 'error': {
        const t = session.outgoing || session.incomingTransfer;
        const reason = msg.reason === 'pairing_required' ? '请先与对方完成配对' : (msg.reason || '对方报告错误');
        if (t && ACTIVE.has(t.status)) this.completeTransfer(t, 'failed', reason);
        return;
      }
      default:
        return;
    }
  }

  async ensureSession(peer) {
    let session = this.sessions.get(peer.id);
    if (session && !session.closed && session.channel && !session.channel.closed) {
      if (session.trusted) return session;
      if (!this.pairRequests.has(peer.id)) this.requestPair(session);
      throw new PairingRequired(session);
    }
    if (!peer.host || !peer.tcpPort) throw new Error('设备当前不在线');
    let channel;
    try {
      channel = await connect(peer.host, peer.tcpPort, this.identity, { tcpPort: this.tcpPort, uiPort: this.uiPort });
    } catch (err) {
      throw new Error(`无法连接 ${peer.name}：${err.message}`);
    }
    session = this.registerChannel(channel, { incoming: false, host: peer.host, port: peer.tcpPort });
    if (!session.trusted) {
      this.requestPair(session);
      throw new PairingRequired(session);
    }
    return session;
  }

  requestPair(session) {
    if (this.pairRequests.has(session.peer.id)) return;
    this.pairRequests.set(session.peer.id, {
      sessionId: session.peer.id,
      peer: session.peer,
      sas: session.sas,
      initiated: true,
      at: Date.now()
    });
    session.channel.send({ t: 'pair_req' }).catch(() => {});
    this.toast(`已向 ${session.peer.name} 发起配对，验证码 ${session.sas}`, 'info');
    this.emitState();
  }

  async acceptPair(peerId) {
    const session = this.sessions.get(peerId);
    if (!session) throw new Error('会话已断开');
    this.trustPeer(session, session.peer.host, session.peer.tcpPort);
    session.trusted = true;
    this.pairRequests.delete(peerId);
    await session.channel.send({ t: 'pair_ok' });
    this.toast(`已与 ${session.peer.name} 配对`, 'success');
    this.emitState();
    await this.resumePending(peerId);
  }

  async declinePair(peerId) {
    const session = this.sessions.get(peerId);
    this.pairRequests.delete(peerId);
    if (session) {
      await session.channel.send({ t: 'pair_deny' }).catch(() => {});
      session.channel.close('pairing declined');
    }
    this.emitState();
  }

  async disconnectPeer(peerId) {
    const session = this.sessions.get(peerId);
    const name = session?.peer?.name || this.trusted.get(peerId)?.name || this.peers.get(peerId)?.name || '对方';
    const notifyUnpair = async (channel) => {
      try {
        await channel.send({ t: 'unpair' });
        await Promise.race([
          new Promise((resolve) => channel.once('close', resolve)),
          new Promise((resolve) => setTimeout(resolve, 1200))
        ]);
      } catch { /* 送达失败由 trust_state 在下次连接时纠正 */ }
    };
    if (session) {
      await notifyUnpair(session.channel);
    } else {
      const entry = this.trusted.get(peerId);
      const known = this.peers.get(peerId) || {};
      const host = entry?.lastHost || known.host;
      const port = entry?.lastPort || known.tcpPort;
      if (host && port) {
        try {
          const channel = await connect(host, Number(port), this.identity, { tcpPort: this.tcpPort, uiPort: this.uiPort });
          if (channel.peer.id === peerId) {
            await notifyUnpair(channel);
            channel.close('user disconnect');
          } else {
            channel.close('peer mismatch');
          }
        } catch { /* 对方离线，送达失败由 trust_state 下次连接时纠正 */ }
      }
    }
    this.untrustPeer(peerId);
    if (session && !session.closed) session.channel.close('user disconnect');
    this.toast(`已断开 ${name}，配对已取消，如需传输请重新配对`, 'info');
    this.emitState();
  }

  untrustPeer(peerId) {
    if (!this.trusted.has(peerId)) return;
    this.trusted.delete(peerId);
    const p = this.peers.get(peerId);
    if (p) {
      p.trusted = false;
      if (this.sessions.has(peerId)) p.online = true;
    }
    this.persistTrusted().catch(() => {});
  }

  async removeHistory(id) {
    const before = this.history.length;
    this.history = this.history.filter((h) => h.id !== id);
    if (this.history.length === before) throw new Error('记录不存在');
    await this.persistHistory();
    this.emitState();
  }

  async clearHistory() {
    if (!this.history.length) return;
    this.history = [];
    await this.persistHistory();
    this.emitState();
  }

  trustPeer(session, host, port) {
    const peer = session.peer;
    const known = this.peers.get(peer.id) || {};
    this.trusted.set(peer.id, {
      id: peer.id,
      name: peer.name,
      fingerprint: peer.fingerprint,
      lastHost: host || peer.host || known.host || session.channel.remoteAddress,
      lastPort: port || peer.tcpPort || known.tcpPort || session.channel.remotePort,
      pairedAt: Date.now()
    });
    const merged = this.peers.get(peer.id) || known;
    this.peers.set(peer.id, { ...merged, ...peer, trusted: true, online: true, lastSeen: Date.now(), host: host || merged.host });
    this.persistTrusted().catch(() => {});
  }

  async resumePending(peerId) {
    const t = this.pendingOut.get(peerId);
    if (!t) return;
    this.pendingOut.delete(peerId);
    try {
      await this.attachSender(t);
    } catch (err) {
      if (err.code === 'PAIRING') {
        this.pendingOut.set(peerId, t);
        t.status = 'pairing';
        this.emitState();
        return;
      }
      this.completeTransfer(t, 'failed', err.message);
    }
  }

  async send(peerId, paths) {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error('未知设备');
    for (const t of this.transfers.values()) {
      if (t.direction === 'out' && t.peer.id === peerId && ACTIVE.has(t.status)) {
        throw new Error('该设备已有正在进行的传输');
      }
    }
    const id = randHex(8);
    const transfer = {
      id,
      direction: 'out',
      peer: { id: peer.id, name: peer.name },
      status: 'preparing',
      rootLabel: '准备中',
      totalBytes: 0,
      totalFiles: 0,
      items: [],
      srcPaths: paths.map((p) => path.resolve(String(p))),
      bytes: 0,
      resumedBytes: 0,
      preparedBytes: 0,
      preparedTotal: 0,
      filesDone: 0,
      currentFile: '',
      speed: 0,
      eta: 0,
      error: null,
      startedAt: Date.now(),
      endedAt: 0,
      session: null,
      sender: null
    };
    this.transfers.set(id, transfer);
    this.emitState();
    const sender = new TransferSender(this, transfer, paths);
    transfer.sender = sender;
    sender
      .prepare()
      .then(() => this.offerWhenReady(transfer))
      .catch((err) => this.completeTransfer(transfer, 'failed', err.message));
    return { id };
  }

  async offerWhenReady(transfer) {
    if (!ACTIVE.has(transfer.status)) return;
    const peer = this.peers.get(transfer.peer.id) || transfer.peer;
    try {
      const session = await this.ensureSession(peer);
      transfer.session = session;
      session.outgoing = transfer;
      await transfer.sender.attach(session);
      await transfer.sender.sendOffer();
    } catch (err) {
      if (err.code === 'PAIRING') {
        transfer.status = 'pairing';
        this.pendingOut.set(peer.id, transfer);
        this.emitState();
        if (this.trusted.has(peer.id)) setTimeout(() => this.resumePending(peer.id), 0);
        return;
      }
      throw err;
    }
  }

  async attachSender(transfer) {
    if (!ACTIVE.has(transfer.status) || transfer.sender.offered) return;
    const peer = this.peers.get(transfer.peer.id) || transfer.peer;
    const session = await this.ensureSession(peer);
    transfer.session = session;
    session.outgoing = transfer;
    await transfer.sender.attach(session);
    await transfer.sender.sendOffer();
  }

  async acceptIncoming(id, destDir) {
    const offer = this.offers.get(id);
    if (!offer) throw new Error('传输请求已失效');
    const session = this.sessions.get(offer.sessionId);
    if (!session) throw new Error('会话已断开');
    const dest = path.resolve(destDir || this.settings.downloadDir);
    const transfer = {
      id,
      direction: 'in',
      peer: { id: offer.peer.id, name: offer.peer.name },
      status: 'starting',
      rootLabel: offer.rootLabel,
      totalBytes: offer.totalBytes,
      totalFiles: offer.totalFiles,
      items: offer.items,
      bytes: 0,
      resumedBytes: 0,
      preparedBytes: offer.totalBytes,
      preparedTotal: offer.totalBytes,
      filesDone: 0,
      currentFile: '',
      speed: 0,
      eta: 0,
      error: null,
      startedAt: Date.now(),
      endedAt: 0,
      session,
      receiver: null,
      destDir: dest
    };
    this.transfers.set(id, transfer);
    this.offers.delete(id);
    session.incomingTransfer = transfer;
    const receiver = new TransferReceiver(this, transfer, offer, dest, this.settings);
    transfer.receiver = receiver;
    try {
      await receiver.start();
      if (offer.totalFiles === 0) {
        await session.channel.send({ t: 'done', id });
        this.completeTransfer(transfer, 'completed');
      }
    } catch (err) {
      await session.channel.send({ t: 'error', reason: err.message }).catch(() => {});
      this.completeTransfer(transfer, 'failed', err.message);
      throw err;
    }
    this.emitState();
    return transfer;
  }

  async declineIncoming(id, reason = 'declined') {
    const offer = this.offers.get(id);
    if (!offer) return;
    this.offers.delete(id);
    const session = this.sessions.get(offer.sessionId);
    if (session) await session.channel.send({ t: 'offer_reject', id, reason }).catch(() => {});
    this.emitState();
  }

  cancelTransfer(id) {
    const t = this.transfers.get(id);
    if (!t) return;
    if (t.guest) {
      if (this.guest) this.guest.cancelBatch(t.guestBatchId || t.id, '主机已取消上传');
      else this.completeTransfer(t, 'canceled', '主机已取消上传');
      return;
    }
    if (t.direction === 'out' && t.sender) t.sender.cancel();
    if (t.direction === 'in' && t.receiver) t.receiver.cancel();
  }

  completeTransfer(t, status, error) {
    if (!t || !ACTIVE.has(t.status)) return;
    t.status = status;
    t.error = error || null;
    t.endedAt = Date.now();
    t.speed = 0;
    t.eta = 0;
    if (t.session) {
      if (t.session.outgoing === t) t.session.outgoing = null;
      if (t.session.incomingTransfer === t) t.session.incomingTransfer = null;
    }
    this.pendingOut.delete(t.peer.id);
    const entry = {
      id: t.id,
      direction: t.direction,
      peer: t.peer,
      rootLabel: t.rootLabel,
      totalBytes: t.totalBytes,
      totalFiles: t.totalFiles,
      filesDone: t.filesDone,
      status,
      error: t.error,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      destDir: t.destDir || null,
      srcPath: t.direction === 'out' && Array.isArray(t.srcPaths) && t.srcPaths.length
        ? (t.srcPaths.length === 1 ? t.srcPaths[0] : path.dirname(t.srcPaths[0]))
        : null,
      guest: Boolean(t.guest),
      guestIp: t.guestIp || null
    };
    this.history.unshift(entry);
    if (this.history.length > 200) this.history.length = 200;
    this.persistHistory().catch(() => {});
    const message = t.guest
      ? status === 'completed'
        ? `访客已上传“${t.rootLabel}”`
        : `访客上传“${t.rootLabel}”${status === 'canceled' ? '已取消' : '失败'}${error ? '：' + error : ''}`
      : status === 'completed'
        ? `${t.direction === 'in' ? '已接收' : '已发送'}“${t.rootLabel}”`
        : `${t.direction === 'in' ? '接收' : '发送'}“${t.rootLabel}”${status === 'canceled' ? '已取消' : '失败'}${error ? '：' + error : ''}`;
    this.toast(
      message,
      status === 'completed' ? 'success' : status === 'canceled' ? 'info' : 'error'
    );
    setTimeout(() => {
      if (this.transfers.get(t.id) === t) this.transfers.delete(t.id);
      this.emitState();
    }, 4000).unref?.();
    this.emitState();
  }

  async dialManual(host, port) {
    const channel = await connect(host, Number(port), this.identity, { tcpPort: this.tcpPort, uiPort: this.uiPort });
    if (channel.peer.id === this.identity.id) {
      channel.close('self connect');
      throw new Error('不能连接本机');
    }
    const session = this.registerChannel(channel, { incoming: false, host, port: Number(port) });
    this.peers.set(session.peer.id, {
      ...this.peers.get(session.peer.id),
      source: 'manual',
      host,
      tcpPort: Number(port),
      lastSeen: Date.now(),
      online: true
    });
    if (!session.trusted) this.requestPair(session);
    this.emitState();
    return { peer: session.peer, sas: session.sas, trusted: session.trusted };
  }

  async updateSettings(patch) {
    if (patch.deviceName && patch.deviceName !== this.settings.deviceName) {
      const name = String(patch.deviceName).slice(0, 64).trim();
      if (name) {
        this.settings.deviceName = name;
        await this.identity.rename(name);
      }
    }
    if (patch.downloadDir) this.settings.downloadDir = path.resolve(String(patch.downloadDir));
    if (typeof patch.autoAccept === 'boolean') this.settings.autoAccept = patch.autoAccept;
    if (typeof patch.archiveEnabled === 'boolean') this.settings.archiveEnabled = patch.archiveEnabled;
    if (typeof patch.discoveryEnabled === 'boolean') this.settings.discoveryEnabled = patch.discoveryEnabled;
    if (Number.isFinite(patch.partialTtlHours)) this.settings.partialTtlHours = Math.max(0, Math.min(720, patch.partialTtlHours));
    let guestChanged = false;
    let guestToggle = false;
    if (typeof patch.guestEnabled === 'boolean' && patch.guestEnabled !== this.settings.guestEnabled) {
      this.settings.guestEnabled = patch.guestEnabled;
      this.settings.guestExpiresAt = patch.guestEnabled && this.settings.guestExpiryHours > 0
        ? Date.now() + this.settings.guestExpiryHours * 3600 * 1000
        : 0;
      guestChanged = true;
      guestToggle = true;
    }
    if (patch.guestPort !== undefined) {
      const port = Number(patch.guestPort);
      if (Number.isFinite(port) && port >= 0 && port <= 65535 && Math.trunc(port) !== this.settings.guestPort) {
        this.settings.guestPort = Math.trunc(port);
        guestChanged = true;
      }
    }
    if (patch.guestExpiryHours !== undefined) {
      const hours = Number(patch.guestExpiryHours);
      if (Number.isFinite(hours)) {
        const next = Math.max(0, Math.min(720, hours));
        if (next !== this.settings.guestExpiryHours) {
          this.settings.guestExpiryHours = next;
          if (this.settings.guestEnabled) {
            this.settings.guestExpiresAt = next > 0 ? Date.now() + next * 3600 * 1000 : 0;
          }
          guestChanged = true;
        }
      }
    }
    if (patch.guestMaxFileMB !== undefined) {
      const value = Number(patch.guestMaxFileMB);
      if (Number.isFinite(value)) this.settings.guestMaxFileMB = Math.max(1, Math.min(1048576, value));
    }
    if (patch.guestMaxBatchMB !== undefined) {
      const value = Number(patch.guestMaxBatchMB);
      if (Number.isFinite(value)) this.settings.guestMaxBatchMB = Math.max(1, Math.min(1048576, value));
    }
    await this.saveSettings();
    if (this.settings.discoveryEnabled) {
      this.startDiscovery();
      if (this.discovery) this.discovery.update({ tcpPort: this.tcpPort, uiPort: this.uiPort || 0 });
    } else if (this.discovery) {
      this.discovery.stop();
      this.discovery = null;
    }
    if (guestChanged) await this.applyGuest({ announce: false });
    if (guestToggle) {
      if (this.settings.guestEnabled) {
        const ok = Boolean(this.guest && this.guest.listening);
        this.toast(
          ok ? '访客上传已开启' : (this.guest?.lastError || '访客上传启动失败'),
          ok ? 'success' : 'error'
        );
      } else {
        this.toast('访客上传已关闭', 'info');
      }
    }
    this.emitState();
  }

  // 恢复出厂设置：保留设备身份（名称），其余回到首次启动的默认值
  async resetSettings() {
    const deviceName = this.settings.deviceName;
    this.settings = {
      deviceName,
      downloadDir: path.join(os.homedir(), 'Downloads', 'LanLink'),
      autoAccept: false,
      archiveEnabled: true,
      partialTtlHours: 24,
      discoveryEnabled: true,
      guestEnabled: false,
      guestPort: 7420,
      guestExpiryHours: 12,
      guestMaxFileMB: 4096,
      guestMaxBatchMB: 20480,
      guestToken: '',
      guestCode: '',
      guestExpiresAt: 0
    };
    await this.saveSettings();
    this.startDiscovery();
    if (this.discovery) this.discovery.update({ tcpPort: this.tcpPort, uiPort: this.uiPort || 0 });
    await this.applyGuest({ announce: false });
    this.toast('已恢复默认设置', 'success');
    this.emitState();
  }

  onTick() {
    const now = Date.now();
    if (this.guest) this.guest.tick(now);
    if (this.settings.guestEnabled && this.settings.guestExpiresAt && now >= this.settings.guestExpiresAt) {
      this.expireGuest().catch(() => {});
    }
    for (const [id, peer] of this.peers) {
      const dropped = peer.offlineAt && peer.offlineAt > (peer.lastSeen || 0);
      peer.online = this.sessions.has(id) || (!dropped && peer.lastSeen && now - peer.lastSeen < 12000);
      if (!peer.trusted && peer.source === 'lan' && now - (peer.lastSeen || 0) > 15000) {
        this.peers.delete(id);
      }
    }
    for (const t of this.transfers.values()) {
      if (t.status === 'transferring' || t.status === 'finishing') {
        const prev = t.lastBytes ?? t.bytes;
        const delta = Math.max(0, t.bytes - prev);
        t.speed = t.speed ? t.speed * 0.65 + delta * 0.35 : delta;
        t.lastBytes = t.bytes;
        const remain = Math.max(0, t.totalBytes - t.bytes);
        t.eta = t.speed > 0 ? Math.round(remain / t.speed) : 0;
      } else if (t.status === 'preparing') {
        const prev = t.lastPrepared ?? t.preparedBytes;
        const delta = Math.max(0, t.preparedBytes - prev);
        t.speed = t.speed ? t.speed * 0.65 + delta * 0.35 : delta;
        t.lastPrepared = t.preparedBytes;
        const remain = Math.max(0, (t.preparedTotal || 0) - t.preparedBytes);
        t.eta = t.speed > 0 ? Math.round(remain / t.speed) : 0;
      }
    }
    this.emitState();
  }

  emitState() {
    this.emit('state');
  }

  toast(message, type = 'info') {
    this.emit('toast', { message, type, at: Date.now() });
  }

  publicTransfer(t) {
    if (!t) return null;
    const total = t.totalBytes || 0;
    const progress = t.status === 'preparing'
      ? (t.preparedTotal ? Math.min(1, t.preparedBytes / t.preparedTotal) : 0)
      : total > 0 ? Math.min(1, t.bytes / total) : 0;
    return {
      id: t.id,
      direction: t.direction,
      peer: t.peer,
      status: t.status,
      rootLabel: t.rootLabel,
      totalBytes: t.totalBytes,
      totalFiles: t.totalFiles,
      bytes: t.bytes,
      resumedBytes: t.resumedBytes || 0,
      preparedBytes: t.preparedBytes,
      preparedTotal: t.preparedTotal,
      filesDone: t.filesDone,
      currentFile: t.currentFile,
      progress,
      speed: Math.round(t.speed || 0),
      eta: t.eta || 0,
      error: t.error,
      destDir: t.destDir || null,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      listeningPort: this.tcpPort,
      guest: Boolean(t.guest),
      guestIp: t.guestIp || null
    };
  }

  snapshot() {
    const peers = [...this.peers.values()]
      .map((p) => ({
        id: p.id,
        name: p.name,
        fingerprint: p.fingerprint,
        host: p.host,
        tcpPort: p.tcpPort,
        trusted: Boolean(p.trusted || this.trusted.has(p.id)),
        online: Boolean(this.sessions.has(p.id) || p.online),
        connected: this.sessions.has(p.id),
        lastSeen: p.lastSeen,
        offlineAt: p.offlineAt || 0,
        source: p.source
      }))
      .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
    return {
      version: '1.0.0',
      device: {
        ...this.identity.info(),
        tcpPort: this.tcpPort,
        uiPort: this.uiPort || null,
        discoveryPort: this.discoveryPort,
        dataDir: this.dataDir,
        os: process.platform,
        arch: process.arch
      },
      settings: {
        deviceName: this.identity.name,
        downloadDir: this.settings.downloadDir,
        autoAccept: this.settings.autoAccept,
        archiveEnabled: this.settings.archiveEnabled,
        partialTtlHours: this.settings.partialTtlHours,
        discoveryEnabled: this.settings.discoveryEnabled,
        guestEnabled: this.settings.guestEnabled,
        guestPort: this.settings.guestPort,
        guestExpiryHours: this.settings.guestExpiryHours,
        guestMaxFileMB: this.settings.guestMaxFileMB,
        guestMaxBatchMB: this.settings.guestMaxBatchMB
      },
      guest: this.guestInfo(),
      peers,
      transfers: [...this.transfers.values()].map((t) => this.publicTransfer(t)).filter(Boolean),
      offers: [...this.offers.values()].map((o) => ({
        id: o.id,
        peer: { id: o.peer.id, name: o.peer.name },
        rootLabel: o.rootLabel,
        totalBytes: o.totalBytes,
        totalFiles: o.totalFiles,
        receivedAt: o.receivedAt
      })),
      pairRequests: [...this.pairRequests.values()],
      history: this.history.slice(0, 100),
      autoTrust: this.autoTrust
    };
  }

  async shutdown() {
    if (this.ticker) clearInterval(this.ticker);
    const guest = this.guest;
    this.guest = null;
    if (guest) await guest.stop();
    for (const s of this.sessions.values()) {
      try { s.channel.close('shutdown'); } catch { /* noop */ }
    }
    this.sessions.clear();
    if (this.discovery) this.discovery.stop();
    await new Promise((resolve) => {
      if (!this.tcpServer) return resolve();
      this.tcpServer.close(() => resolve());
      setTimeout(resolve, 1000).unref?.();
    });
  }
}

module.exports = { Manager, PairingRequired };
