// Queue-owned device leases and input. No local ADB fallback in queue mode.
const fs = require('node:fs');
const http = require('node:http');
function failure(code, status = 503) { return Object.assign(new Error(code), { code, status, pause: true }); }
function queueMode(env = process.env) {
  const mode = env.CRAWLER_DEVICE_LOCK_MODE || 'legacy';
  if (!['legacy', 'queue'].includes(mode)) throw failure('INVALID_DEVICE_LOCK_MODE', 500);
  return mode === 'queue';
}
class AndroidQueueClient {
  constructor({ env = process.env, request = http.request } = {}) {
    const url = new URL(env.CRAWLER_SERVICE_URL || 'http://127.0.0.1:18323');
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw failure('INVALID_CRAWLER_SERVICE_URL', 500);
    this.origin = url.origin; this.tokenFile = env.CRAWLER_SERVICE_TOKEN_FILE; this.request = request;
  }
  call(method, route, body) {
    let token;
    try { token = fs.readFileSync(this.tokenFile, 'utf8').trim(); } catch { return Promise.reject(failure('CRAWLER_SERVICE_TOKEN_REQUIRED', 500)); }
    if (token.length < 32) return Promise.reject(failure('CRAWLER_SERVICE_TOKEN_REQUIRED', 500));
    const encoded = body === undefined ? null : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      let settled = false, timer;
      const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
      const req = this.request(this.origin + route, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(encoded ? { 'Content-Length': Buffer.byteLength(encoded) } : {}) } }, res => {
        const chunks = []; let size = 0;
        res.on('data', chunk => { size += chunk.length; if (size > 16 * 1024 * 1024) { finish(failure('CRAWLER_RESPONSE_LIMIT')); res.destroy(); } else chunks.push(chunk); });
        res.on('error', () => finish(failure('CRAWLER_SERVICE_UNAVAILABLE')));
        res.on('end', () => {
          let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { finish(failure('CRAWLER_RESPONSE_INVALID')); return; }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const code = value?.error?.code;
            finish(failure(typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,100}$/.test(code) ? code : 'CRAWLER_SERVICE_FAILED', res.statusCode)); return;
          }
          finish(null, value);
        });
      });
      // Do not abort input requests with the UI signal: the server must finish or
      // stop its already-started command before release can transfer ownership.
      timer = setTimeout(() => { finish(failure('CRAWLER_SERVICE_TIMEOUT')); req.destroy(); }, 45000);
      req.on('error', () => finish(failure('CRAWLER_SERVICE_UNAVAILABLE')));
      if (encoded) req.write(encoded); req.end();
    });
  }
  devices() { return this.call('GET', '/v1/devices'); }
  acquire(serial, owner) { return this.call('POST', '/v1/device-leases', { serial, owner }); }
  heartbeat(lease) { return this.call('POST', '/v1/device-leases/heartbeat', { lease }); }
  release(lease) { return this.call('POST', '/v1/device-leases/release', { lease }); }
  command(lease, serial, args) { return this.call('POST', '/v1/device-leases/command', { lease, serial, args }); }
}
module.exports = { AndroidQueueClient, queueMode, failure };
