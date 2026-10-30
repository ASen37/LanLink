'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

const caseCache = new Map();

async function pathExists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

// 探测目录所在文件系统是否区分大小写；结果按目录缓存
async function isCaseInsensitive(dir) {
  if (caseCache.has(dir)) return caseCache.get(dir);
  let result = process.platform === 'win32';
  try {
    await fsp.mkdir(dir, { recursive: true });
    const probe = path.join(dir, `.lanlink-case-${process.pid}-${Date.now()}`);
    await fsp.writeFile(probe, '');
    try {
      const lower = probe.toLowerCase();
      if (lower !== probe) {
        const stat = await fsp.stat(lower).catch(() => null);
        result = Boolean(stat);
      }
    } finally {
      await fsp.rm(probe, { force: true }).catch(() => {});
    }
  } catch {
    /* 探测失败时保留平台默认值 */
  }
  caseCache.set(dir, result);
  return result;
}

// 目标路径分配：同一最终路径只允许一个活跃任务认领，冲突时自动加序号
class DestinationRegistry {
  constructor() {
    this.claims = new Map();
    this.locks = new Map();
  }

  async keyFor(dir, absPath) {
    const insensitive = await isCaseInsensitive(dir);
    return insensitive ? absPath.toLowerCase() : absPath;
  }

  async claim(dir, relPath, ownerId) {
    const baseAbs = path.resolve(dir, relPath);
    const baseKey = await this.keyFor(dir, baseAbs);
    const held = this.claims.get(baseKey);
    if (held) {
      if (held.ownerId === ownerId) {
        return { finalPath: held.finalPath, key: baseKey, renamed: held.finalPath !== baseAbs };
      }
      return this.claimConflict(dir, baseAbs, ownerId);
    }
    this.claims.set(baseKey, { ownerId, finalPath: baseAbs, at: Date.now() });
    return { finalPath: baseAbs, key: baseKey, renamed: false };
  }

  async claimConflict(dir, baseAbs, ownerId) {
    const parsed = path.parse(baseAbs);
    for (let index = 2; index < 1000; index += 1) {
      const candidate = path.join(parsed.dir, `${parsed.name} (${index})${parsed.ext}`);
      const key = await this.keyFor(dir, candidate);
      if (this.claims.has(key)) continue;
      this.claims.set(key, { ownerId, finalPath: candidate, at: Date.now() });
      if (await pathExists(candidate)) {
        this.claims.delete(key);
        continue;
      }
      return { finalPath: candidate, key, renamed: true };
    }
    throw new Error('同名文件过多，无法分配目标路径');
  }

  releasePath(key, ownerId) {
    const held = this.claims.get(key);
    if (held && held.ownerId === ownerId) this.claims.delete(key);
  }

  releaseOwner(ownerId) {
    for (const [key, held] of this.claims) {
      if (held.ownerId === ownerId) this.claims.delete(key);
    }
  }

  async withPathLock(key, task) {
    const previous = this.locks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const chain = previous.then(() => gate);
    this.locks.set(key, chain);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.locks.get(key) === chain) this.locks.delete(key);
    }
  }
}

module.exports = { DestinationRegistry, isCaseInsensitive, pathExists };
