'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {PhoneRuntime,processStart}=require('../adapters/xhs-phone/runtime');
function fixture(t,{running=true}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'phone-runtime-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const binary=path.join(dir,'frida');fs.writeFileSync(binary,'fixture');const sha=crypto.createHash('sha256').update('fixture').digest('hex');
 const calls=[],state={running,start:'12345',version:'9.51.0',removeFail:false,appPid:'123',forward:false};
 const stat=()=>`900 (frida server) ${['S',...Array(18).fill('0'),state.start].join(' ')}`;
 const adb={serial:'s',devices:async()=>[{serial:'s',state:'device'}],wait:async()=>{},shell:async(...args)=>{
  calls.push(args);
  if(args[0]==='pidof')return args[1]==='com.xingin.xhs'?state.appPid:state.running?'900':'';
  if(args[0]==='dumpsys'&&args[1]==='package')return 'versionName='+state.version;
  if(args[0]==='dumpsys')return `mResumedActivity: ActivityRecord{abc u0 com.xingin.xhs/.Main}\n * Hist #0: ActivityRecord{abc u0 com.xingin.xhs/.Main}\n app=ProcessRecord{xyz ${state.appPid}:com.xingin.xhs/u0}`;
  if(args[0]==='am'&&args[1]==='force-stop'){state.appPid='456';return '';}
  if(args[0]==='pm')return 'package:/data/app/~~pkg==/base.apk';
  if(args[0]==='cat')return 'com.xingin.xhs\0';
  return '';
 },command:async args=>{
  calls.push(args);
  if(args[0]==='forward'){if(args[1]==='tcp:0'){state.forward=true;return '41000';}if(args[1]==='--list')return state.forward?'s tcp:41000 tcp:27043':'';if(args[1]==='--remove'&&state.removeFail)throw Error('remove');return '';}
  const cmd=args[3]||'';
  if(cmd.includes('sha256sum'))return sha+' file';
  if(cmd.includes(' -l ')){state.running=true;return '';}
  if(cmd.includes('kill ')){state.running=false;return '';}
  if(cmd.includes('/stat'))return stat();
  return '';
 }};
 let clock=0;const runtime=new PhoneRuntime(adb,{now:()=>clock+=1000,binary,sha256:sha,contract:{package:'com.xingin.xhs',version:'9.51.0',apk_sha256:sha}});
 return {runtime,adb,state,calls,stat};
}
test('passive runtime borrows existing server and owns only its explicit forward',async t=>{
 const {runtime,calls}=fixture(t);assert.equal((await runtime.ensure()).endpoint,'127.0.0.1:41000');await runtime.close();
 assert.ok(calls.some(a=>a[0]==='forward'&&a[1]==='--remove'&&a[2]==='tcp:41000'));
 assert.ok(!calls.some(a=>(a[3]||'').includes('kill ')));
});
test('owned runtime cleanup is idempotent and checks process creation identity',async t=>{
 const {runtime,calls,stat}=fixture(t,{running:false});assert.equal(processStart(stat()),'12345');await runtime.ensure();await runtime.close();const count=calls.length;await runtime.close();
 assert.equal(calls.length,count);assert.ok(calls.some(a=>(a[3]||'').includes('kill 900')));
});
test('PID reuse does not authorize killing a replacement runtime',async t=>{
 const {runtime,calls,state}=fixture(t,{running:false});await runtime.ensure();state.start='99999';await runtime.close();assert.ok(!calls.some(a=>(a[3]||'').includes('kill ')));
});
test('one cleanup failure does not skip other owned cleanup',async t=>{
 const {runtime,calls,state}=fixture(t,{running:false});await runtime.ensure();state.removeFail=true;await assert.rejects(runtime.close(),{code:'RUNTIME_CLEANUP_FAILED'});
 assert.ok(calls.some(a=>(a[3]||'').includes('kill 900')));state.removeFail=false;await runtime.close();assert.equal(runtime.forward,null);
});
test('passive mode still enforces App version before runtime setup',async t=>{
 const {runtime,calls,state}=fixture(t);state.version='unknown';await assert.rejects(runtime.ensure(),{code:'APP_VERSION_MISMATCH'});assert.ok(!calls.some(a=>a[0]==='forward'||a[0]==='push'));
});

test('warm App recovery restarts only XHS, reacquires its PID and retains owned forward/runtime',async t=>{
 const {runtime,calls}=fixture(t,{running:false});const first=await runtime.ensure(),server=runtime.ownedServer;
 const recovered=await runtime.restartApp();
 assert.equal(first.pid,123);assert.equal(recovered.pid,456);assert.equal(recovered.endpoint,first.endpoint);assert.equal(runtime.ownedServer,server);
 assert.deepEqual(calls.filter(a=>a[0]==='am'),[['am','force-stop','com.xingin.xhs']]);
 assert.equal(calls.filter(a=>a[0]==='forward'&&a[1]==='tcp:0').length,1);
 assert.ok(!calls.some(a=>a.includes('clear')||a.includes('uninstall')));
 await runtime.close();assert.equal(calls.filter(a=>a[0]==='forward'&&a[1]==='--remove').length,1);
 assert.equal(calls.filter(a=>(a[3]||'').includes('kill 900')).length,1);
});
test('warm App recovery refuses an unknown version before stopping the App',async t=>{
 const {runtime,state,calls}=fixture(t);await runtime.ensure();state.version='changed';
 await assert.rejects(runtime.restartApp(),{code:'APP_VERSION_MISMATCH'});
 assert.ok(!calls.some(a=>a[0]==='am'));await runtime.close();
});
