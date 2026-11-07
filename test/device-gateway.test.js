'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');const {PassThrough}=require('node:stream');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../service/store');const {DeviceGateway,validateCommand}=require('../service/device_gateway');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function spawning({autoCloseOnKill=true}={}){
 const children=[];
 const spawn=(exe,args,options)=>{
  const child=new EventEmitter();child.pid=10000+children.length;child.stdout=new PassThrough();child.stderr=new PassThrough();child.exe=exe;child.args=args;child.options=options;child.signals=[];child.closed=false;
  child.finish=(code=0,stdout='',stderr='')=>{if(child.closed)return;child.closed=true;if(stdout)child.stdout.write(stdout);if(stderr)child.stderr.write(stderr);child.emit('close',code);};
  child.kill=signal=>{child.signals.push(signal);if(autoCloseOnKill)setImmediate(()=>child.finish(1));return true;};children.push(child);return child;
 };
 return {spawn,children};
}
function fixture(t,options={}){
 const store=new Store(':memory:',options.storeOptions);store.register({id:'p1',kind:'android',serial:'SERIAL1'});store.register({id:'p2',kind:'android',serial:'SERIAL2'});
 const runner=spawning(options),gateway=new DeviceGateway(store,{adbPath:'/configured/adb',spawnProcess:runner.spawn,pollMs:2,timeoutMs:1000,killGraceMs:5,...options.gatewayOptions});
 t.after(async()=>{for(const child of runner.children)child.finish(1);await gateway.close();store.close();});
 return {store,gateway,...runner};
}
const tap=['shell',"'input'","'tap'","'10'","'20'"];
test('gateway owns execution, injects registered serial and preserves quoted shell arguments',async t=>{
 const {store,gateway,children}=fixture(t),lease=store.externalLease('p1','parse-links');
 const task=gateway.execute(lease,{args:tap,serial:'SERIAL1'});await tick();
 assert.equal(children.length,1);assert.equal(children[0].exe,'/configured/adb');assert.deepEqual(children[0].args,['-s','SERIAL1','shell',"'input' 'tap' '10' '20'"]);
 assert.equal(children[0].options.env.ENABLE_TIKHUB_NETWORK,'0');assert.equal(children[0].options.env.ENABLE_LLM_NETWORK,'0');
 children[0].finish(0,'ok');assert.deepEqual(await task,{stdout:'ok',stderr:''});assert.equal(gateway.status('p1'),null);
});
test('same lease commands serialize while different phones execute concurrently',async t=>{
 const {store,gateway,children}=fixture(t),a=store.externalLease('p1','a'),b=store.externalLease('p2','b');
 const first=gateway.execute(a,{args:tap}),second=gateway.execute(a,{args:tap}),other=gateway.execute(b,{args:tap});await tick();
 assert.equal(children.length,2);assert.deepEqual(children.map(c=>c.args[1]).sort(),['SERIAL1','SERIAL2']);
 children.find(c=>c.args[1]==='SERIAL1').finish();await first;await tick();assert.equal(children.length,3);
 children[2].finish();children.find(c=>c.args[1]==='SERIAL2').finish();await Promise.all([second,other]);
});
test('persistent command row prevents another gateway process from issuing an overlapping input',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gateway-shared-')),file=path.join(dir,'queue.db');
 const a=new Store(file),b=new Store(file);a.register({id:'p1',kind:'android',serial:'SERIAL1'});
 const one=spawning(),two=spawning(),g1=new DeviceGateway(a,{spawnProcess:one.spawn}),g2=new DeviceGateway(b,{spawnProcess:two.spawn});
 t.after(async()=>{for(const c of [...one.children,...two.children])c.finish(1);await g1.close();await g2.close();a.close();b.close();fs.rmSync(dir,{recursive:true,force:true});});
 const lease=a.externalLease('p1','owner'),running=g1.execute(lease,{args:tap});await tick();
 await assert.rejects(g2.execute(lease,{args:tap}),{code:'DEVICE_COMMAND_BUSY'});assert.equal(two.children.length,0);assert.ok(g2.status('p1'));
 one.children[0].finish();await running;const next=g2.execute(lease,{args:tap});await tick();two.children[0].finish();await next;
});
test('unsafe host/device commands and a mismatched serial never spawn',async t=>{
 const {store,gateway,children}=fixture(t),lease=store.externalLease('p1','owner');
 const commands=[['kill-server'],['-s','OTHER','shell','input','tap','1','1'],['shell','su','-c','id'],['shell','input tap 1 2'],['shell','input','tap','1;id','2'],['shell','cat','/data/data/private'],['push','/home/secret','/sdcard/file'],['shell','rm','-f','/sdcard/other.xml'],['reverse','tcp:1','tcp:1'],['shell','screenrecord','/sdcard/video.mp4']];
 for(const args of commands)await assert.rejects(gateway.execute(lease,{args}),{code:'ADB_COMMAND_UNSUPPORTED'});
 await assert.rejects(gateway.execute(lease,{args:tap,serial:'OTHER'}),{code:'DEVICE_IDENTITY_MISMATCH'});assert.equal(children.length,0);
});
test('clipboard reverse is per-device and URLs are generated as literal remote shell tokens',t=>{
 const {store}=fixture(t),device=store.devices().find(d=>d.id==='p1'),port=device.clipboard_port;
 assert.deepEqual(validateCommand(['reverse',`tcp:${port}`,`tcp:${port}`],device).args,['reverse',`tcp:${port}`,`tcp:${port}`]);
 assert.throws(()=>validateCommand(['reverse',`tcp:${port+1}`,`tcp:${port+1}`],device),{code:'ADB_COMMAND_UNSUPPORTED'});
 const url='https://www.xiaohongshu.com/explore/'+'a'.repeat(24)+'?xsec_token=fixture&source=share';
 const checked=validateCommand(['shell','am','start','-a','android.intent.action.VIEW','-d',url,'-p','com.xingin.xhs'],device);
 assert.ok(checked.args[1].includes("'"+url+"'"));
 assert.throws(()=>validateCommand(['shell','am','start','-a','android.intent.action.VIEW','-d','https://evil.test','-p','com.xingin.xhs'],device),{code:'ADB_COMMAND_UNSUPPORTED'});
});
test('cancel drains the actual child and blocks queued work before releasing command ownership',async t=>{
 const {store,gateway,children}=fixture(t,{autoCloseOnKill:false}),lease=store.externalLease('p1','owner');
 const first=gateway.execute(lease,{args:tap}),second=gateway.execute(lease,{args:tap});const results=Promise.allSettled([first,second]);await tick();
 let drained=false;const cancel=gateway.cancel(lease).then(()=>{drained=true;});await delay(10);
 assert.equal(drained,false);assert.ok(gateway.status('p1'));assert.deepEqual(children[0].signals,['SIGTERM','SIGKILL']);assert.equal(store.devices()[0].quarantined,1);
 children[0].finish(1);await cancel;const outcomes=await results;assert.equal(children.length,1);assert.ok(outcomes.every(r=>r.status==='rejected'&&r.reason.code==='DEVICE_COMMAND_CANCELLED'));assert.equal(gateway.status('p1'),null);
});
test('lease expiry aborts a running command and fences stale inputs after recovery',async t=>{
 let now=1;const {store,gateway,children}=fixture(t,{storeOptions:{now:()=>now,leaseMs:10}}),lease=store.externalLease('p1','owner');
 const running=gateway.execute(lease,{args:tap});const rejected=assert.rejects(running,{code:'LEASE_LOST'});await tick();now=12;await delay(10);await rejected;
 assert.equal(children[0].signals[0],'SIGTERM');assert.equal(store.devices()[0].quarantined,1);store.expire();store.recoverDevice('p1',{stopped:true});
 const next=store.externalLease('p1','new');await assert.rejects(gateway.execute(lease,{args:tap}),{code:'LEASE_LOST'});assert.equal(children.length,1);
 const valid=gateway.execute(next,{args:tap});await tick();children[1].finish();await valid;
});
test('loss of the legacy barrier aborts an in-flight command',async t=>{
 let held=true;const {store,gateway,children}=fixture(t,{gatewayOptions:{beforeCommand:()=>{if(!held)throw Object.assign(Error('lost'),{code:'LEGACY_BARRIER_LOST'});}}});
 const lease=store.externalLease('p1','owner'),running=gateway.execute(lease,{args:tap});const rejected=assert.rejects(running,{code:'LEGACY_BARRIER_LOST'});await tick();held=false;await delay(10);await rejected;
 assert.equal(children[0].signals[0],'SIGTERM');assert.equal(store.devices()[0].quarantined,1);
});
test('one-shot screen capture preserves binary bytes without enabling a stream',async t=>{
 const {store,gateway,children}=fixture(t),lease=store.externalLease('p1','console');const result=gateway.execute(lease,{args:['exec-out','screencap','-p']});await tick();
 const bytes=Buffer.from([0x89,0x50,0x4e,0x47,0xff,0x00]);children[0].finish(0,bytes);const response=await result;
 assert.equal(response.stdout,'');assert.deepEqual(Buffer.from(response.stdout_base64,'base64'),bytes);
});
test('ADB errors expose stable codes and never stderr contents',async t=>{
 const {store,gateway,children}=fixture(t),lease=store.externalLease('p1','tool');const result=gateway.execute(lease,{args:tap});const rejected=assert.rejects(result,error=>error.code==='INPUT_PERMISSION_REQUIRED'&&!error.message.includes('fixture-secret'));await tick();
 children[0].finish(1,'','SecurityException: injecting requires INJECT_EVENTS permission fixture-secret');await rejected;
});
test('orphaned command ownership is retained until a supervisor confirms stop',async t=>{
 const {store,gateway}=fixture(t),lease=store.externalLease('p1','tool');
 store.db.prepare("INSERT INTO device_commands VALUES (?,?,?,?,?,?,?,'running',?)").run('p1','orphan',lease.token,lease.generation,'former',99999,99998,1);
 await assert.rejects(gateway.execute(lease,{args:tap}),{code:'DEVICE_COMMAND_BUSY'});
 assert.throws(()=>gateway.confirmStopped('p1',{commandId:'orphan'}),{code:'WORKER_STOP_REQUIRED'});
 store.db.prepare('UPDATE devices SET quarantined=1 WHERE id=?').run('p1');gateway.confirmStopped('p1',{commandId:'orphan',stopped:true});
 assert.equal(gateway.status('p1'),null);assert.equal(store.devices()[0].quarantined,1);
});
test('trusted runtime setup uses the same lease and cleanup cannot issue input',async t=>{
 const {store,gateway,children}=fixture(t),lease=store.externalLease('p1','runtime');
 const run=gateway.executeTrusted(lease,{args:['forward','tcp:0','tcp:27043']});await tick();assert.equal(children.length,1);children[0].finish(0,'40123');assert.equal((await run).stdout,'40123');
 await assert.rejects(gateway.executeTrusted(lease,{args:tap},{cleanup:true}),{code:'RUNTIME_CLEANUP_UNSUPPORTED'});
 store.db.prepare('UPDATE devices SET quarantined=1 WHERE id=?').run('p1');
 const cleanup=gateway.executeTrusted(lease,{args:['forward','--remove','tcp:40123']},{cleanup:true});await tick();children[1].finish();await cleanup;
 store.releaseExternal(lease);await assert.rejects(gateway.executeTrusted(lease,{args:['forward','--remove','tcp:40123']},{cleanup:true}),{code:'LEASE_LOST'});
});
test('configured rooted phone retries only numeric input on actual INJECT_EVENTS denial',async t=>{
 const {store,gateway,children}=fixture(t,{gatewayOptions:{rootInputSerials:['SERIAL1']}}),lease=store.externalLease('p1','console');
 const action=gateway.execute(lease,{args:tap});await tick();children[0].finish(1,'','SecurityException: injecting requires INJECT_EVENTS permission');await tick();
 assert.equal(children.length,2);assert.deepEqual(children[1].args,['-s','SERIAL1','shell','su','-c',"'input tap 10 20'"]);children[1].finish();await action;
 const other=store.externalLease('p2','console'),denied=gateway.execute(other,{args:tap});const rejected=assert.rejects(denied,{code:'INPUT_PERMISSION_REQUIRED'});await tick();children[2].finish(1,'','SecurityException: injecting requires INJECT_EVENTS permission');await rejected;assert.equal(children.length,3);
 await assert.rejects(gateway.execute(lease,{args:['shell','su','-c','id']}),{code:'ADB_COMMAND_UNSUPPORTED'});
});
test('root input fallback rechecks cancellation and cannot revive revoked control',async t=>{
 const {store,gateway,children}=fixture(t,{gatewayOptions:{rootInputSerials:['SERIAL1']}}),lease=store.externalLease('p1','console'),controller=new AbortController();
 const action=gateway.execute(lease,{args:tap},{signal:controller.signal});const rejected=assert.rejects(action,{code:'DEVICE_COMMAND_CANCELLED'});await tick();
 children[0].finish(1,'','SecurityException: injecting requires INJECT_EVENTS permission');controller.abort();await rejected;assert.equal(children.length,1);
});
test('long provisioning timeout is internal-only and bounded',async t=>{
 const {store,gateway,children}=fixture(t,{gatewayOptions:{timeoutMs:5}}),lease=store.externalLease('p1','provision');
 await assert.rejects(gateway.executeTrusted(lease,{args:['forward','--list']},{timeoutMs:180001}),{code:'INVALID_GATEWAY_TIMEOUT'});assert.equal(children.length,0);
 await assert.rejects(gateway.execute(lease,{args:tap},{timeoutMs:180000}),{code:'ADB_COMMAND_TIMEOUT'});assert.equal(children.length,1);
});
test('normal release retires admission and drains a completed touch without quarantining',async t=>{
 const {store,gateway,children}=fixture(t),lease=store.externalLease('p1','console');
 const active=gateway.execute(lease,{args:tap});await tick();let released=false;const retired=gateway.retire(lease).then(()=>{released=true;});await tick();assert.equal(released,false);assert.deepEqual(children[0].signals,[]);
 const late=gateway.execute(lease,{args:tap}).catch(e=>e);children[0].finish();await active;await retired;assert.equal((await late).code,'DEVICE_COMMAND_CANCELLED');assert.equal(gateway.requiresRecovery(),false);assert.equal(store.devices().find(d=>d.id==='p1').quarantined,0);
 store.releaseExternal(lease);gateway.forgetReleased(lease);
});

test('installer failure exposes only its stable code',async t=>{
 const {store,gateway,children}=fixture(t),lease=store.externalLease('p1','provision');
 const result=gateway.executeTrusted(lease,{args:['install-multiple','-r','/private/base.apk']});
 const rejected=assert.rejects(result,error=>error.code==='INSTALL_FAILED_USER_RESTRICTED'&&!error.message.includes('fixture-secret'));
 await tick();children[0].finish(1,'Failure [INSTALL_FAILED_USER_RESTRICTED: fixture-secret]');await rejected;
});
