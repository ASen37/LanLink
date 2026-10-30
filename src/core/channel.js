'use strict';

const net = require('node:net');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { once } = require('node:events');

const MAX_INNER = 8 * 1024 * 1024;
const PROTOCOL = 'LanLink/1.0';

class PlainReader {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.ended = false;
    this.waiters = [];
    this.onData = (d) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
      this.notify();
    };
    this.onEnd = () => {
      this.ended = true;
      this.notify();
    };
    socket.on('data', this.onData);
    socket.on('close', this.onEnd);
    socket.on('error', this.onEnd);
  }

  notify() {
    const list = this.waiters;
    this.waiters = [];
    for (const fn of list) fn();
  }

  async wait() {
    if (this.ended) throw new Error('connection closed during handshake');
    await new Promise((resolve) => this.waiters.push(resolve));
    if (this.ended) throw new Error('connection closed during handshake');
  }

  async next() {
    for (;;) {
      if (this.buf.length >= 4) {
        const len = this.buf.readUInt32BE(0);
        if (len <= 0 || len > 64 * 1024) throw new Error('invalid handshake frame');
        if (this.buf.length >= 4 + len) {
          const payload = this.buf.subarray(4, 4 + len);
          this.buf = this.buf.subarray(4 + len);
          return JSON.parse(payload.toString('utf8'));
        }
      }
      await this.wait();
    }
  }

  detach() {
    this.socket.off('data', this.onData);
    this.socket.off('close', this.onEnd);
    this.socket.off('error', this.onEnd);
    return this.buf;
  }
}

function writePlain(socket, obj) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    const frame = Buffer.allocUnsafe(4 + payload.length);
    frame.writeUInt32BE(payload.length, 0);
    payload.copy(frame, 4);
    socket.write(frame, (err) => (err ? reject(err) : resolve()));
  });
}

function rawPublicKey(pubB64) {
  return Buffer.from(pubB64, 'base64url');
}

function verifyPeerId(peer) {
  if (!peer || typeof peer.id !== 'string' || typeof peer.pub !== 'string' || typeof peer.eph !== 'string') {
    throw new Error('malformed hello');
  }
  const raw = rawPublicKey(peer.pub);
  const id = crypto.createHash('sha256').update(raw).digest().subarray(0, 20).toString('hex');
  if (id !== peer.id) throw new Error('peer identity mismatch');
  return id;
}

async function handshake(socket, identity, isClient, info = {}) {
  socket.setNoDelay(true);
  socket.setTimeout(10000);
  const onTimeout = () => socket.destroy(new Error('handshake timeout'));
  socket.once('timeout', onTimeout);
  const reader = new PlainReader(socket);
  const eph = require('./crypto').createEphemeral();
  const hello = {
    t: 'hello',
    v: 1,
    app: PROTOCOL,
    id: identity.id,
    name: identity.name.slice(0, 64),
    pub: identity.publicB64,
    eph: eph.publicB64,
    nonce: crypto.randomBytes(16).toString('base64url'),
    os: process.platform,
    tcpPort: Number(info.tcpPort) || 0,
    uiPort: Number(info.uiPort) || 0,
    requireCode: info.requireCode !== false
  };

  let clientHello;
  let serverHello;
  try {
    if (isClient) {
      clientHello = hello;
      await writePlain(socket, hello);
      serverHello = await reader.next();
    } else {
      serverHello = hello;
      clientHello = await reader.next();
      await writePlain(socket, hello);
    }
    if (clientHello.t !== 'hello' || clientHello.v !== 1 || clientHello.app !== PROTOCOL) {
      throw new Error('unsupported peer protocol');
    }
    verifyPeerId(clientHello);
    verifyPeerId(serverHello);

    const { deriveShared, deriveSessionKeys, shortAuthString } = require('./crypto');
    const shared = deriveShared(eph.privateKey, isClient ? serverHello.eph : clientHello.eph);
    const transcript = crypto
      .createHash('sha256')
      .update('LanLinkHS1\n')
      .update(JSON.stringify(clientHello))
      .update('\n')
      .update(JSON.stringify(serverHello))
      .update('\n')
      .update(shared.toString('hex'))
      .digest();

    const sig = identity.sign(transcript);
    const peerPub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: serverHello === hello ? clientHello.pub : serverHello.pub }, format: 'jwk' });

    let peerAuth;
    if (isClient) {
      await writePlain(socket, { t: 'auth', sig: sig.toString('base64') });
      peerAuth = await reader.next();
      if (peerAuth.t !== 'auth') throw new Error('expected auth');
      const ok = crypto.verify(null, transcript, peerPub, Buffer.from(peerAuth.sig, 'base64'));
      if (!ok) throw new Error('peer signature verification failed');
    } else {
      peerAuth = await reader.next();
      if (peerAuth.t !== 'auth') throw new Error('expected auth');
      const ok = crypto.verify(null, transcript, peerPub, Buffer.from(peerAuth.sig, 'base64'));
      if (!ok) throw new Error('peer signature verification failed');
      await writePlain(socket, { t: 'auth', sig: sig.toString('base64') });
    }

    socket.setTimeout(0);
    socket.off('timeout', onTimeout);
    const leftover = reader.detach();
    const keys = deriveSessionKeys(shared, transcript);
    const sas = shortAuthString(transcript, identity.id, serverHello === hello ? clientHello.id : serverHello.id);
    const peerId = serverHello === hello ? clientHello.id : serverHello.id;
    const peerName = (serverHello === hello ? clientHello.name : serverHello.name) || 'Unknown device';
    const peerPubRaw = rawPublicKey(serverHello === hello ? clientHello.pub : serverHello.pub);

    return new Channel(socket, {
      isClient,
      leftover,
      sas,
      peer: {
        id: peerId,
        name: peerName.slice(0, 64),
        pub: (serverHello === hello ? clientHello.pub : serverHello.pub),
        fingerprint: crypto.createHash('sha256').update(peerPubRaw).digest('hex'),
        os: (serverHello === hello ? clientHello.os : serverHello.os) || 'unknown',
        tcpPort: Number((serverHello === hello ? clientHello.tcpPort : serverHello.tcpPort)) || 0,
        uiPort: Number((serverHello === hello ? clientHello.uiPort : serverHello.uiPort)) || 0,
        requireCode: ((serverHello === hello ? clientHello : serverHello).requireCode) !== false
      },
      sendKey: isClient ? keys.c2s : keys.s2c,
      recvKey: isClient ? keys.s2c : keys.c2s
    });
  } catch (err) {
    socket.off('timeout', onTimeout);
    try { socket.destroy(); } catch { /* noop */ }
    throw err;
  }
}

class Channel extends EventEmitter {
  constructor(socket, opts) {
    super();
    const { Sealer } = require('./crypto');
    this.socket = socket;
    this.peer = opts.peer;
    this.remoteAddress = socket.remoteAddress;
    this.remotePort = socket.remotePort;
    this.sas = opts.sas;
    this.isClient = opts.isClient;
    this.sendSealer = new Sealer(opts.sendKey, opts.isClient ? 1 : 2);
    this.recvSealer = new Sealer(opts.recvKey, opts.isClient ? 2 : 1);
    this.chunks = opts.leftover && opts.leftover.length ? [Buffer.from(opts.leftover)] : [];
    this.buffered = this.chunks.length ? this.chunks[0].length : 0;
    this.closed = false;
    this.lastRecv = Date.now();
    this.writeChain = Promise.resolve();

    socket.on('data', (d) => this.onData(d));
    socket.on('close', () => this.finish('closed'));
    socket.on('error', (err) => this.fail(err));

    this.heartbeat = setInterval(() => {
      if (this.closed) return;
      if (Date.now() - this.lastRecv > 30000) {
        this.fail(new Error('peer timeout'));
        return;
      }
      this.send({ t: 'ping' }).catch(() => {});
    }, 10000);
    this.heartbeat.unref?.();

    if (this.buffered) this.drain();
  }

  onData(data) {
    if (this.closed) return;
    this.lastRecv = Date.now();
    if (!data.length) return;
    this.chunks.push(data);
    this.buffered += data.length;
    this.drain();
  }

  peekLength() {
    const first = this.chunks[0];
    if (first.length >= 4) return first.readUInt32BE(0);
    let value = 0;
    let need = 4;
    for (const chunk of this.chunks) {
      for (let i = 0; i < chunk.length && need > 0; i++) {
        value = value * 256 + chunk[i];
        need -= 1;
      }
      if (need === 0) break;
    }
    return value >>> 0;
  }

  take(n) {
    this.buffered -= n;
    const first = this.chunks[0];
    if (first.length >= n) {
      const out = first.subarray(0, n);
      if (first.length === n) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
      return out;
    }
    const out = Buffer.allocUnsafe(n);
    let offset = 0;
    while (offset < n) {
      const chunk = this.chunks[0];
      const len = Math.min(chunk.length, n - offset);
      chunk.copy(out, offset, 0, len);
      offset += len;
      if (len === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(len);
    }
    return out;
  }

  drain() {
    try {
      while (!this.closed && this.buffered >= 4) {
        const len = this.peekLength();
        if (len <= 16 || len > MAX_INNER + 16) throw new Error('invalid encrypted frame length');
        if (this.buffered < 4 + len) return;
        this.take(4);
        const payload = this.take(len);
        this.handleFrame(payload);
      }
    } catch (err) {
      this.fail(err);
    }
  }

  handleFrame(payload) {
    const plain = this.recvSealer.decrypt(payload);
    if (!plain.length) throw new Error('empty frame');
    const type = plain[0];
    if (type === 1) {
      const msg = JSON.parse(plain.subarray(1).toString('utf8'));
      if (msg.t === 'ping') {
        this.send({ t: 'pong' }).catch(() => {});
        return;
      }
      if (msg.t === 'pong') return;
      this.emit('message', msg);
    } else if (type === 2) {
      if (plain.length < 5) throw new Error('malformed data frame');
      const headerLen = plain.readUInt32BE(1);
      if (headerLen > plain.length - 5) throw new Error('malformed data header');
      const header = JSON.parse(plain.subarray(5, 5 + headerLen).toString('utf8'));
      const body = plain.subarray(5 + headerLen);
      this.emit('chunk', header, body);
    } else {
      throw new Error('unknown frame type');
    }
  }

  async writeFrame(frame) {
    if (this.closed) throw new Error('channel closed');
    if (this.socket.write(frame)) return;
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        this.socket.off('drain', onDrain);
        this.socket.off('close', onClose);
        this.socket.off('error', onError);
      };
      const onDrain = () => { cleanup(); resolve(); };
      const onClose = () => { cleanup(); reject(new Error('channel closed')); };
      const onError = (err) => { cleanup(); reject(err); };
      this.socket.once('drain', onDrain);
      this.socket.once('close', onClose);
      this.socket.once('error', onError);
    });
  }

  send(obj) {
    const task = async () => {
      const inner = Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify(obj), 'utf8')]);
      if (inner.length > MAX_INNER) throw new Error('message too large');
      const enc = this.sendSealer.encrypt(inner);
      const frame = Buffer.allocUnsafe(4 + enc.length);
      frame.writeUInt32BE(enc.length, 0);
      enc.copy(frame, 4);
      await this.writeFrame(frame);
    };
    const next = this.writeChain.then(task);
    this.writeChain = next.catch(() => {});
    next.catch((err) => this.fail(err));
    return next;
  }

  sendData(header, body) {
    const task = async () => {
      const h = Buffer.from(JSON.stringify(header), 'utf8');
      const inner = Buffer.allocUnsafe(1 + 4 + h.length + body.length);
      inner[0] = 2;
      inner.writeUInt32BE(h.length, 1);
      h.copy(inner, 5);
      body.copy(inner, 5 + h.length);
      if (inner.length > MAX_INNER) throw new Error('chunk too large');
      const enc = this.sendSealer.encrypt(inner);
      const frame = Buffer.allocUnsafe(4 + enc.length);
      frame.writeUInt32BE(enc.length, 0);
      enc.copy(frame, 4);
      await this.writeFrame(frame);
    };
    const next = this.writeChain.then(task);
    this.writeChain = next.catch(() => {});
    next.catch((err) => this.fail(err));
    return next;
  }

  fail(err) {
    if (this.closed) return;
    this.finish('error', err);
  }

  finish(reason, err) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    try { this.socket.destroy(); } catch { /* noop */ }
    if (err) this.emit('error', err);
    this.emit('close', reason);
  }

  close(reason = 'local') {
    this.finish(reason);
  }
}

async function connect(host, port, identity, info = {}, timeoutMs = 10000) {
  const socket = net.connect({ host, port });
  socket.setNoDelay(true);
  const timer = setTimeout(() => socket.destroy(new Error('connect timeout')), timeoutMs);
  try {
    await once(socket, 'connect');
    clearTimeout(timer);
    return await handshake(socket, identity, true, info);
  } catch (err) {
    clearTimeout(timer);
    socket.destroy();
    throw err;
  }
}

async function accept(socket, identity, info = {}) {
  return handshake(socket, identity, false, info);
}

module.exports = { Channel, connect, accept };
