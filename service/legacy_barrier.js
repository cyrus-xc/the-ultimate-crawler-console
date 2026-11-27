'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {problem} = require('./contract');

// Linux releases these locks when the service exits, including after SIGKILL.
class LegacyBarrier {
  constructor(root, queueRoot = root) {
    if (!root || !path.isAbsolute(root)) throw problem('LEGACY_LOCK_DIRECTORY_REQUIRED', 500);
    this.file = path.join(root, '.worker.lock');
    this.roots = [root, queueRoot];
    this.handles = [];
    this.held = false;
  }
  async acquire() {
    if (this.held) return;
    for (const root of this.roots) fs.mkdirSync(root, {recursive: true, mode: 0o700});
    try {
      for (const root of new Set(this.roots.map(dir => fs.realpathSync(dir)))) {
        const fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
        this.handles.push(fd);
        // flock and the parent share the same open file description through fd 3.
        const lock = spawnSync('flock', ['--nonblock', '3'], {stdio: ['ignore', 'ignore', 'ignore', fd]});
        if (lock.status !== 0) throw problem(lock.status === 1 ? 'LEGACY_WORKER_BUSY' : 'LEGACY_BARRIER_FAILED', 409);
      }
      const staged = this.file + '.' + randomUUID();
      fs.writeFileSync(staged, String(process.pid), {flag: 'wx', mode: 0o600});
      try { fs.renameSync(staged, this.file); } finally { fs.rmSync(staged, {force: true}); }
      this.held = true;
    } catch (error) {
      this.unlock();
      throw error;
    }
  }
  assert() {
    let owner;
    try { owner = fs.readFileSync(this.file, 'utf8'); } catch {}
    if (!this.held || owner !== String(process.pid)) throw problem('LEGACY_BARRIER_LOST', 409);
  }
  unlock() {
    for (const fd of this.handles.splice(0)) fs.closeSync(fd);
    this.held = false;
  }
  async release() {
    if (!this.held) return;
    try {
      if (fs.readFileSync(this.file, 'utf8') === String(process.pid)) fs.unlinkSync(this.file);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    finally { this.unlock(); }
  }
}
module.exports = {LegacyBarrier};
