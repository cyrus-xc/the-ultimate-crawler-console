'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {randomUUID} = require('node:crypto');
const {start} = require('../service/main');
const {Store} = require('../service/store');
const {DeviceGateway} = require('../service/device_gateway');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-owner-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const token = path.join(root, 'token'), adb = path.join(root, 'adb'), locks = path.join(root, 'locks');
  fs.writeFileSync(token, randomUUID());
  fs.writeFileSync(adb, '#!/bin/sh\nprintf "List of devices attached\\nA device model:A\\nB device model:B\\n"\n', {mode: 0o700});
  const env = {PATH: process.env.PATH, CRAWLER_RUNTIME_DIR: root, CRAWLER_SERVICE_TOKEN_FILE: token,
    ADB_PATH: adb, CRAWLER_DEVICE_GATEWAY_ENABLED: 'true', CRAWLER_LEGACY_ANDROID_LOCK_DIR: locks,
    XHS_RAW_EVIDENCE_ROOT: path.join(root, 'evidence'), XHS_RAW_EVIDENCE_MOUNT: '',
    ENABLE_LLM_NETWORK: '0', ENABLE_TIKHUB_NETWORK: '0'};
  return {env, db: path.join(root, 'queue.db'), lock: path.join(locks, '.worker.lock')};
}

test('a live service retains its allocation; after a crash the next start reassigns the interrupted unit', {timeout: 10000}, async t => {
  const f = fixture(t);
  const script = `(async () => {
    const {store} = await require('./service/main').start({listen:false});
    store.register({id:'android:A',serial:'A',kind:'android',capabilities:[{platform:'xiaohongshu',operation:'post.detail'}]});
    store.quarantine('android:B','ADB_COMMAND_TIMEOUT');
    store.submit({schema_version:'crawler.request.v1',idempotency_key:'crash-test',platform:'xiaohongshu',operation:'post.detail',targets:[{post_id:'one'}]});
    const claim=store.claim();
    store.commit(claim,{items:[{key:'one',value:{body:'preserved'}}],checkpoint:{page:1}});
    process.send(claim);
    setInterval(()=>{},1000);
  })().catch(()=>process.exit(1));`;
  const child = spawn(process.execPath, ['-e', script], {cwd: path.resolve(__dirname, '..'),
    env: f.env, stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const [claim] = await once(child, 'message');
  await assert.rejects(start({env: f.env, listen: false}), {code: 'LEGACY_WORKER_BUSY'});
  const prior = new Store(f.db);
  try { assert.equal(prior.assertLease(claim.lease).token, claim.lease.token); } finally { prior.close(); }
  const exit = once(child, 'exit');
  child.kill('SIGKILL');
  await exit;
  assert.equal(fs.readFileSync(f.lock, 'utf8'), String(child.pid));

  const service = await start({env: f.env, listen: false});
  try {
    const s = service.store;
    assert.equal(fs.readFileSync(f.lock, 'utf8'), String(process.pid));
    assert.throws(() => s.assertLease(claim.lease), {code: 'LEASE_LOST'});
    assert.equal(s.devices().find(d => d.serial === 'B').quarantined, 1);
    assert.equal(s.results(claim.request_id).length, 1);
    const next = s.claim();
    assert.equal(next.unit_id, claim.unit_id);
    assert.notEqual(next.lease.token, claim.lease.token);
    assert.deepEqual(next.checkpoint, {page: 1});
    s.commit(next, {done: true});
  } finally { await service.close(); }
  assert.equal(fs.existsSync(f.lock), false);
  const again = await start({env: f.env, listen: false});
  try { assert.equal(again.store.request(claim.request_id).state, 'succeeded'); } finally { await again.close(); }
});

test('an abandoned PID with no leases starts even before USB devices appear', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.lock));
  fs.writeFileSync(f.lock, '999999999');
  fs.writeFileSync(f.env.ADB_PATH, '#!/bin/sh\nprintf "List of devices attached\\n"\n');
  const service = await start({env: f.env, listen: false});
  try {
    assert.equal(fs.readFileSync(f.lock, 'utf8'), String(process.pid));
    assert.equal(service.store.devices().length, 0);
  } finally { await service.close(); }
});

test('failed startup clears stale leases and command records; device isolation survives', async t => {
  const f = fixture(t);
  const saved = new Store(f.db);
  new DeviceGateway(saved);
  saved.register({id: 'android:A', kind: 'android', serial: 'A'});
  const lease = saved.externalLease('android:A', 'old-owner');
  saved.db.prepare('INSERT INTO device_commands VALUES (?,?,?,?,?,?,?,?,?)')
    .run('android:A', 'unfinished', lease.token, lease.generation, 'old-gateway', 1, null, 'running', 0);
  saved.close();
  await assert.rejects(start({env: {...f.env, CRAWLER_PORT: '0'}, listen: false}), {code: 'INVALID_PORT'});
  assert.equal(fs.existsSync(f.lock), false);
  const next = await start({env: f.env, listen: false});
  try {
    const device = next.store.devices().find(d => d.serial === 'A');
    assert.equal(device.owner, null);
    assert.equal(device.quarantined, 1);
    assert.equal(next.gateway.status(device.id), null);
    assert.throws(() => next.store.assertLease(lease), {code: 'LEASE_LOST'});
  } finally { await next.close(); }
});
