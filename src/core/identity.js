'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

class Identity {
  constructor(dataDir, name, keys, createdAt) {
    this.dataDir = dataDir;
    this.name = name;
    this.privateKey = keys.privateKey;
    this.publicKey = keys.publicKey;
    this.publicRaw = keys.publicRaw;
    this.createdAt = createdAt;
    const digest = crypto.createHash('sha256').update(this.publicRaw).digest();
    this.id = digest.subarray(0, 20).toString('hex');
    this.fingerprint = digest.toString('hex');
  }

  static async load(dataDir, defaultName) {
    const file = path.join(dataDir, 'identity.json');
    await fsp.mkdir(dataDir, { recursive: true });
    try {
      const raw = JSON.parse(await fsp.readFile(file, 'utf8'));
      const priv = crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.x, d: raw.d }, format: 'jwk' });
      const pub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.x }, format: 'jwk' });
      return new Identity(dataDir, raw.name || defaultName, {
        privateKey: priv,
        publicKey: pub,
        publicRaw: Buffer.from(raw.x, 'base64url')
      }, raw.createdAt || Date.now());
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const jwk = privateKey.export({ format: 'jwk' });
    const identity = new Identity(dataDir, defaultName, {
      privateKey,
      publicKey,
      publicRaw: Buffer.from(jwk.x, 'base64url')
    }, Date.now());
    await identity.save();
    return identity;
  }

  async save() {
    const jwk = this.privateKey.export({ format: 'jwk' });
    const file = path.join(this.dataDir, 'identity.json');
    const tmp = file + '.tmp';
    const payload = JSON.stringify({
      version: 1,
      name: this.name,
      x: jwk.x,
      d: jwk.d,
      createdAt: this.createdAt
    }, null, 2);
    await fsp.writeFile(tmp, payload, { mode: 0o600 });
    await fsp.rename(tmp, file);
  }

  async rename(name) {
    this.name = name || this.name;
    await this.save();
  }

  sign(data) {
    return crypto.sign(null, data, this.privateKey);
  }

  setPublicKey(x) {
    this.publicKey = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
  }

  get publicB64() {
    return this.privateKey.export({ format: 'jwk' }).x;
  }

  info() {
    return {
      id: this.id,
      name: this.name,
      fingerprint: this.fingerprint,
      shortFingerprint: this.fingerprint.slice(0, 16).match(/.{1,4}/g).join(' '),
      createdAt: this.createdAt
    };
  }
}

function defaultDeviceName() {
  const host = os.hostname().replace(/\.local$/i, '');
  return host || 'LanLink Device';
}

module.exports = { Identity, defaultDeviceName };
