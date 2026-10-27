'use strict';

const crypto = require('node:crypto');

function hkdf(sharedSecret, salt, info, length = 32) {
  const out = crypto.hkdfSync('sha256', sharedSecret, salt, Buffer.from(info), length);
  return Buffer.from(out);
}

function createEphemeral() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  const jwk = privateKey.export({ format: 'jwk' });
  return { privateKey, publicKey, publicB64: jwk.x };
}

function importX25519(publicB64) {
  return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: publicB64 }, format: 'jwk' });
}

function deriveShared(ephemeralPrivate, peerPublicB64) {
  return crypto.diffieHellman({ privateKey: ephemeralPrivate, publicKey: importX25519(peerPublicB64) });
}

function deriveSessionKeys(shared, transcript) {
  return {
    c2s: hkdf(shared, transcript, 'lanlink v1 client-to-server'),
    s2c: hkdf(shared, transcript, 'lanlink v1 server-to-client')
  };
}

function shortAuthString(transcript, idA, idB) {
  const ids = [idA, idB].sort().join('|');
  const digest = crypto.createHash('sha256').update(transcript).update('|').update(ids).digest();
  const number = digest.readUInt32BE(0) % 1000000;
  return String(number).padStart(6, '0');
}

class Sealer {
  constructor(key, directionByte) {
    this.key = key;
    this.direction = directionByte;
    this.counter = 0n;
  }

  nonce() {
    const buf = Buffer.alloc(12);
    buf.writeUInt32BE(this.direction, 0);
    buf.writeBigUInt64BE(this.counter, 4);
    return buf;
  }

  encrypt(plaintext) {
    const nonce = this.nonce();
    this.counter += 1n;
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, nonce);
    const body = cipher.update(plaintext);
    cipher.final();
    const tag = cipher.getAuthTag();
    const out = Buffer.allocUnsafe(body.length + tag.length);
    body.copy(out, 0);
    tag.copy(out, body.length);
    return out;
  }

  decrypt(payload) {
    if (payload.length < 16) throw new Error('frame too short');
    const nonce = this.nonce();
    this.counter += 1n;
    const tag = payload.subarray(payload.length - 16);
    const body = payload.subarray(0, payload.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, nonce);
    decipher.setAuthTag(tag);
    const out = decipher.update(body);
    decipher.final();
    return out;
  }
}

module.exports = {
  hkdf,
  createEphemeral,
  importX25519,
  deriveShared,
  deriveSessionKeys,
  shortAuthString,
  Sealer
};
