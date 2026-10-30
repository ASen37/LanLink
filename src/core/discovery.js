'use strict';

const dgram = require('node:dgram');
const os = require('node:os');

const GROUP = '239.255.42.99';

class Discovery {
  constructor({ identity, tcpPort, uiPort, port, requireCode, onPeer, onLog }) {
    this.identity = identity;
    this.tcpPort = tcpPort;
    this.uiPort = uiPort || 0;
    this.port = port;
    this.requireCode = requireCode !== false;
    this.onPeer = onPeer;
    this.onLog = onLog;
    this.socket = null;
    this.timer = null;
    this.stopped = false;
  }

  start() {
    try {
      this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.socket.on('error', (err) => this.onLog?.(`discovery socket: ${err.message}`));
      this.socket.on('message', (buf, rinfo) => {
        if (!buf || buf.length > 4096) return;
        try {
          const packet = JSON.parse(buf.toString('utf8'));
          if (packet && packet.v === 1) this.onPeer?.(packet, rinfo);
        } catch { /* ignore malformed packets */ }
      });
      this.socket.bind(this.port, '0.0.0.0', () => {
        try {
          this.socket.addMembership(GROUP);
          this.socket.setMulticastTTL(1);
          this.socket.setMulticastLoopback(true);
          this.socket.setBroadcast(true);
        } catch (err) {
          this.onLog?.(`discovery setup: ${err.message}`);
        }
        this.announce();
        this.timer = setInterval(() => this.announce(), 2500);
        this.timer.unref?.();
      });
    } catch (err) {
      this.onLog?.(`discovery disabled: ${err.message}`);
    }
  }

  update({ tcpPort, uiPort, requireCode }) {
    if (tcpPort) this.tcpPort = tcpPort;
    if (uiPort !== undefined) this.uiPort = uiPort;
    if (requireCode !== undefined) this.requireCode = requireCode !== false;
    this.announce();
  }

  announce() {
    if (!this.socket || this.stopped) return;
    const packet = Buffer.from(JSON.stringify({
      v: 1,
      id: this.identity.id,
      name: this.identity.name,
      fingerprint: this.identity.fingerprint,
      tcpPort: this.tcpPort,
      uiPort: this.uiPort,
      requireCode: this.requireCode !== false,
      os: process.platform,
      host: os.hostname(),
      ts: Date.now()
    }));
    const send = (address) => {
      this.socket.send(packet, 0, packet.length, this.port, address, (err) => {
        if (err && address === GROUP) this.onLog?.(`discovery announce: ${err.message}`);
      });
    };
    try {
      send(GROUP);
      send('255.255.255.255');
      send('127.0.0.1');
    } catch (err) {
      this.onLog?.(`discovery send: ${err.message}`);
    }
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.socket) {
      try { this.socket.close(); } catch { /* noop */ }
      this.socket = null;
    }
  }
}

module.exports = { Discovery, GROUP };
