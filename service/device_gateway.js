'use strict';
const {spawn} = require('node:child_process');
const {randomUUID} = require('node:crypto');
const {problem} = require('./contract');

const PACKAGES = new Set(['com.xingin.xhs', 'com.ss.android.ugc.aweme', 'com.android.chrome']);
const DUMPS = new Set(['/sdcard/handygadgets-ui.xml', '/sdcard/douyin-poi-ui.xml']);
const XHS_HOSTS = new Set(['xiaohongshu.com', 'www.xiaohongshu.com', 'xhslink.com', 'www.xhslink.com', 'xhslink.cn', 'www.xhslink.cn']);
const DY_HOSTS = new Set(['douyin.com', 'www.douyin.com', 'v.douyin.com']);
const keyOf = lease => `${lease.device_id}:${lease.generation}:${lease.token}`;
const integer = (value, max=32767) => /^\d+$/.test(value) && Number(value) <= max;
const unsupported = () => { throw problem('ADB_COMMAND_UNSUPPORTED', 400); };

function shellToken(value) {
  // AndroidAdb.shell historically wraps every argument separately. Do not pass
  // those strings through to a second shell or accept partial/mixed quoting.
  if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
  if (!value || /[\x00-\x20'"`\\$;|<>]/.test(value)) unsupported();
  return value;
}
function navigationUrl(value, pkg, device) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.username || url.password) return false;
  if (pkg === 'com.android.chrome') {
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && Number(url.port) === device.clipboard_port && /^\/[a-f0-9]{48}$/.test(url.pathname) && !url.search && !url.hash;
  }
  if (pkg === 'com.xingin.xhs' && url.protocol === 'xhsdiscover:') {
    return ['item','user','profile'].includes(url.hostname) && /^\/(?:profile\/)?[a-f0-9]{24}$/i.test(url.pathname) && !url.search && !url.hash;
  }
  if (pkg === 'com.ss.android.ugc.aweme' && url.protocol === 'snssdk1128:') {
    return (url.hostname === 'aweme' && /^\/detail\/\d+$/.test(url.pathname) && !url.search) ||
      (url.hostname === 'search' && !url.pathname && [...url.searchParams.keys()].every(k => k === 'keyword') && !!url.searchParams.get('keyword'));
  }
  return ['http:', 'https:'].includes(url.protocol) && (!url.port || ['80', '443'].includes(url.port)) &&
    (pkg === 'com.xingin.xhs' ? XHS_HOSTS : DY_HOSTS).has(url.hostname);
}
function validateCommand(args, device) {
  if (!Array.isArray(args) || !args.length || args.length > 320 || args.some(a => typeof a !== 'string' || a.length > 16384 || /[\x00\r\n]/.test(a))) unsupported();
  if (args.length === 1 && args[0] === 'get-state') return {args: [...args], binary: false};
  if (args.length === 3 && args[0] === 'exec-out' && args[1] === 'screencap' && args[2] === '-p') return {args: [...args], binary: true};
  if (args[0] === 'reverse') {
    const port = `tcp:${device.clipboard_port}`;
    if (args.length !== 3 || args[2] !== port || ![port, '--remove'].includes(args[1])) unsupported();
    return {args: [...args], binary: false};
  }
  if (args[0] !== 'shell' || args.length < 2) unsupported();
  const words = args.slice(1).map(shellToken), [command, ...rest] = words;
  let valid = false;
  if (command === 'input') {
    const [action, ...values] = rest;
    valid = (action === 'tap' && values.length === 2 && values.every(v => integer(v))) ||
      (action === 'swipe' && [4,5].includes(values.length) && values.slice(0,4).every(v => integer(v)) && (values.length === 4 || integer(values[4],5000))) ||
      (action === 'keyevent' && values.length > 0 && values.length <= 300 && values.every(v => integer(v,1000)));
  } else if (command === 'uiautomator') valid = rest.length === 2 && rest[0] === 'dump' && DUMPS.has(rest[1]);
  else if (command === 'cat') valid = rest.length === 1 && DUMPS.has(rest[0]);
  else if (command === 'rm') valid = rest.length === 2 && rest[0] === '-f' && DUMPS.has(rest[1]);
  else if (command === 'wm') valid = rest.length === 1 && rest[0] === 'size';
  else if (command === 'dumpsys') valid = (rest.length === 2 && rest[0] === 'activity' && rest[1] === 'activities') || (rest.length === 2 && rest[0] === 'package' && PACKAGES.has(rest[1]));
  else if (command === 'pm') valid = (rest.length === 3 && rest[0] === 'list' && rest[1] === 'packages' && PACKAGES.has(rest[2])) || (rest.length === 2 && rest[0] === 'path' && PACKAGES.has(rest[1]));
  else if (command === 'monkey') valid = rest.length === 5 && rest[0] === '-p' && PACKAGES.has(rest[1]) && rest[2] === '-c' && rest[3] === 'android.intent.category.LAUNCHER' && rest[4] === '1';
  else if (command === 'am') valid = rest.length === 7 && rest[0] === 'start' && rest[1] === '-a' && rest[2] === 'android.intent.action.VIEW' && rest[3] === '-d' && rest[5] === '-p' && PACKAGES.has(rest[6]) && navigationUrl(rest[4],rest[6],device);
  else if (command === 'getprop') valid = rest.length === 1 && ['ro.product.model','ro.product.device','ro.build.version.release','ro.build.version.sdk'].includes(rest[0]);
  if (!valid) unsupported();
  // ADB reparses shell arguments remotely. Generate one fully quoted command;
  // URL query separators remain literal and cannot become shell operators.
  return {args: ['shell', words.map(word => `'${word}'`).join(' ')], binary: false};
}

class DeviceGateway {
  constructor(store, {adbPath='adb', spawnProcess=spawn, beforeCommand=()=>{}, pollMs=100, timeoutMs=15000, killGraceMs=1000, maxOutputBytes=16*1024*1024}={}) {
    if (typeof adbPath !== 'string' || !adbPath || typeof beforeCommand !== 'function' || pollMs < 1 || timeoutMs < 1 || killGraceMs < 1) throw problem('INVALID_GATEWAY_CONFIG',500);
    this.store=store;this.adbPath=adbPath;this.spawnProcess=spawnProcess;this.beforeCommand=beforeCommand;
    this.pollMs=pollMs;this.timeoutMs=timeoutMs;this.killGraceMs=killGraceMs;this.maxOutputBytes=maxOutputBytes;
    this.id=randomUUID();this.tails=new Map();this.operations=new Map();this.active=new Map();this.cancelled=new Set();this.closing=false;
    store.db.exec(`CREATE TABLE IF NOT EXISTS device_commands (
      device_id TEXT PRIMARY KEY REFERENCES devices(id), command_id TEXT UNIQUE NOT NULL,
      token TEXT NOT NULL, generation INTEGER NOT NULL, gateway_id TEXT NOT NULL,
      gateway_pid INTEGER NOT NULL, pid INTEGER, state TEXT NOT NULL, started INTEGER NOT NULL
    )`);
    // A previous process may have lost its ADB client without stopping Android's
    // remote shell. Never infer remote completion from local child exit alone.
    this.recoveryRequired=!!store.db.prepare('SELECT 1 FROM device_commands LIMIT 1').get() ||
      !!store.db.prepare("SELECT 1 FROM devices WHERE kind='android' AND quarantined=1 LIMIT 1").get();
  }
  requiresRecovery() {
    return this.recoveryRequired || !!this.store.db.prepare('SELECT 1 FROM device_commands LIMIT 1').get() ||
      !!this.store.db.prepare("SELECT 1 FROM devices WHERE kind='android' AND quarantined=1 LIMIT 1").get();
  }
  assert(lease) {
    this.beforeCommand();
    const row=this.store.assertLease ? this.store.assertLease(lease) : this.store.fence(lease);
    const device=this.store.db.prepare('SELECT * FROM devices WHERE id=?').get(lease.device_id);
    if (!device || device.kind !== 'android' || !/^[\w.:-]+$/.test(device.serial || '')) throw problem('ANDROID_DEVICE_REQUIRED',409);
    if (device.quarantined) throw problem('DEVICE_QUARANTINED',409);
    if (row.attempt_id) {
      const work=this.store.db.prepare('SELECT u.state,r.state request_state FROM attempts a JOIN units u ON u.id=a.unit_id JOIN requests r ON r.id=u.request_id WHERE a.id=?').get(row.attempt_id);
      if (!work || work.state !== 'running' || work.request_state !== 'running') throw problem('WORKER_INPUT_NOT_ALLOWED',409);
    }
    return device;
  }
  status(deviceId) {
    return this.store.db.prepare('SELECT device_id,command_id,gateway_id,gateway_pid,pid,state,started FROM device_commands WHERE device_id=?').get(deviceId) || null;
  }
  execute(lease, {args,serial}={}, {signal}={}) {
    if (this.closing) return Promise.reject(problem('GATEWAY_CLOSED',503));
    let device, command;
    try { device=this.assert(lease);if(serial!==undefined && serial!==device.serial)throw problem('DEVICE_IDENTITY_MISMATCH',409);command=validateCommand(args,device); }
    catch(error) { return Promise.reject(error); }
    const key=keyOf(lease), previous=this.tails.get(device.id) || Promise.resolve();
    const operation=previous.catch(()=>{}).then(()=>this.run(lease,command,signal));
    this.tails.set(device.id,operation);
    if (!this.operations.has(key)) this.operations.set(key,new Set());
    this.operations.get(key).add(operation);
    operation.finally(()=>{
      this.operations.get(key)?.delete(operation);if(!this.operations.get(key)?.size)this.operations.delete(key);
      if(this.tails.get(device.id)===operation)this.tails.delete(device.id);
    }).catch(()=>{});
    return operation;
  }
  async run(lease, command, signal) {
    const key=keyOf(lease);
    if(this.closing || this.cancelled.has(key) || signal?.aborted)throw problem('DEVICE_COMMAND_CANCELLED',409);
    const commandId=randomUUID();
    const device=this.store.tx(()=>{
      const device=this.assert(lease);
      if(this.status(device.id))throw problem('DEVICE_COMMAND_BUSY',409);
      this.store.db.prepare("INSERT INTO device_commands(device_id,command_id,token,generation,gateway_id,gateway_pid,state,started) VALUES (?,?,?,?,?,?,'running',?)").run(device.id,commandId,lease.token,lease.generation,this.id,process.pid,this.store.now());
      return device;
    });
    let child, failure, killTimer, timer, monitor, closePromise, closed=false, stopping=false, outputBytes=0;
    const stdout=[],stderr=[];
    const quarantine=()=>this.store.db.prepare('UPDATE devices SET quarantined=1 WHERE id=?').run(device.id);
    const abort=reason=>{
      if(!failure)failure=reason;
      if(child && !stopping && !closed){
        stopping=true;this.recoveryRequired=true;
        quarantine();this.store.db.prepare("UPDATE device_commands SET state='stopping' WHERE command_id=?").run(commandId);
        child.kill('SIGTERM');killTimer=setTimeout(()=>child.kill('SIGKILL'),this.killGraceMs);
      }
    };
    const onAbort=()=>abort(problem('DEVICE_COMMAND_CANCELLED',409));
    this.active.set(commandId,{key,abort});
    try {
      this.assert(lease);
      // Only the configured executable and the database serial reach spawn.
      child=this.spawnProcess(this.adbPath,['-s',device.serial,...command.args],{stdio:['ignore','pipe','pipe'],windowsHide:true,env:{...process.env,ENABLE_TIKHUB_NETWORK:'0',ENABLE_LLM_NETWORK:'0'}});
      closePromise=new Promise(resolve=>{
        child.once('error',()=>{if(!failure)failure=problem('ADB_UNAVAILABLE',503);});
        child.once('close',code=>{closed=true;resolve(code);});
      });
      if(Number.isInteger(child.pid))this.store.db.prepare('UPDATE device_commands SET pid=? WHERE command_id=?').run(child.pid,commandId);
      const collect=(target,data)=>{outputBytes+=data.length;if(outputBytes>this.maxOutputBytes)abort(problem('ADB_OUTPUT_LIMIT',502));else target.push(Buffer.from(data));};
      child.stdout.on('data',data=>collect(stdout,data));child.stderr.on('data',data=>collect(stderr,data));
      signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();
      timer=setTimeout(()=>abort(problem('ADB_COMMAND_TIMEOUT',504)),this.timeoutMs);
      monitor=setInterval(()=>{try{this.assert(lease);}catch(error){abort(error);}},this.pollMs);
      const code=await closePromise;
      if(failure)throw failure;
      this.assert(lease);
      if(code!==0){
        if(/SecurityException:[^\r\n]*requires INJECT_EVENTS permission/.test(Buffer.concat(stderr).toString('utf8')))throw problem('INPUT_PERMISSION_REQUIRED',409);
        throw problem('ADB_COMMAND_FAILED',502);
      }
      const bytes=Buffer.concat(stdout);
      return command.binary ? {stdout:'',stdout_base64:bytes.toString('base64'),stderr:''} : {stdout:bytes.toString('utf8'),stderr:''};
    } catch(error) {
      if(child && !closed && closePromise){abort(error);await closePromise;}
      throw error;
    } finally {
      clearTimeout(timer);clearTimeout(killTimer);clearInterval(monitor);signal?.removeEventListener('abort',onAbort);
      this.active.delete(commandId);
      // This point is reached only after child close (or spawn never succeeded).
      this.store.db.prepare('DELETE FROM device_commands WHERE command_id=? AND gateway_id=?').run(commandId,this.id);
    }
  }
  async cancel(lease) {
    const key=keyOf(lease);this.cancelled.add(key);
    for(const active of this.active.values())if(active.key===key)active.abort(problem('DEVICE_COMMAND_CANCELLED',409));
    await this.drain(lease);
  }
  forgetReleased(lease) {
    if(this.store.db.prepare('SELECT 1 FROM leases WHERE token=? AND generation=?').get(lease.token,lease.generation))throw problem('LEASE_STILL_ACTIVE',409);
    this.cancelled.delete(keyOf(lease));
  }
  async drain(lease) { await Promise.allSettled([...(this.operations.get(keyOf(lease)) || [])]); }
  confirmStopped(deviceId,{commandId,stopped=false}={}) {
    if(!stopped || this.active.has(commandId))throw problem('WORKER_STOP_REQUIRED',409);
    return this.store.tx(()=>{
      const current=this.status(deviceId);
      if(!current || current.command_id!==commandId)throw problem('DEVICE_COMMAND_NOT_FOUND',404);
      this.store.db.prepare('DELETE FROM device_commands WHERE device_id=? AND command_id=?').run(deviceId,commandId);
      // Quarantine remains until the supervisor explicitly recovers the device.
    });
  }
  async close() {
    this.closing=true;
    for(const active of this.active.values())active.abort(problem('GATEWAY_CLOSED',503));
    await Promise.allSettled([...this.tails.values()]);
  }
}
module.exports={DeviceGateway,validateCommand};
