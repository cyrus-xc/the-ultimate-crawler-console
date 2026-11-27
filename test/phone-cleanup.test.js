'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs');
const {spawn}=require('node:child_process');
const {Store}=require('../service/store');
const {DeviceGateway}=require('../service/device_gateway');
const {makeTransport}=require('../adapters/xhs-phone/consumer');
const {PhoneRuntime}=require('../adapters/xhs-phone/runtime');

// Keep the real runtime -> transport -> gateway chain. Only ADB is simulated;
// the disappearing /proc read runs in a real shell, with a nonexistent PID.
function fixture(t,{exitAfterKill=false,readFails=false,killFails=false,processStillAlive=false}={}){
 const pid='2147483647',start='12345',commands=[];
 assert.equal(fs.existsSync('/proc/'+pid),false);
 const stat=`${pid} (runtime) ${['S',...Array(18).fill('0'),start].join(' ')}`;
 const store=new Store();store.register({id:'phone',kind:'android',serial:'CLEANUP_PHONE'});
 const lease=store.externalLease('phone','cleanup-test');let reads=0;
 const gateway=new DeviceGateway(store,{spawnProcess:(_executable,args,options)=>{
  const command=args.slice(2);commands.push(command);
  let script='exit 0',argv=[];
  if(command[0]==='shell'&&command[1]==="'pidof'"){
   script='printf "%s\\n" "$1"';argv=[pid]; // pidof races with process exit.
  }else if(command[0]==='shell'&&command[1]==='su'){
   const root=command[3].slice(1,-1);
   if(root.startsWith('cat ')){
    if(readFails)script='exit 1';
    else if(exitAfterKill&&(reads++===0||processStillAlive)){script='printf "%s" "$1"';argv=[stat];}
    else script=root;
   }else{assert.equal(root,'kill '+pid);if(killFails)script='exit 1';}
  }else assert.equal(command[0],'forward');
  return spawn('/bin/sh',['-c',script,'cleanup-test',...argv],options);
 }});
 const adb=makeTransport({store,gateway,claim:{device_id:'phone',lease},context:{guard(){throw Error('cleanup must retain its lease without business input');}},cleanup:true});
 const runtime=new PhoneRuntime(adb,{binary:__filename,sha256:'0'.repeat(64),contract:{package:'com.xingin.xhs',version:'9.51.0'}});
 runtime.forward=41000;runtime.ownedServer={pid,start};
 t.after(async()=>{await gateway.drain(lease);store.releaseExternal(lease);await gateway.close();store.close();});
 return {runtime,commands,store,gateway,lease};
}

for(const exitAfterKill of [false,true])test('cleanup confirms the owned process is absent '+(exitAfterKill?'after kill':'before kill'),async t=>{
 const {runtime,commands,store}=fixture(t,{exitAfterKill});
 await runtime.close();
 assert.equal(runtime.ownedServer,null);assert.equal(runtime.forward,null);
 assert.equal(store.devices()[0].quarantined,0);
 assert.equal(commands.filter(c=>c[3]?.includes('kill ')).length,exitAfterKill?1:0);
});

test('cleanup retains ownership and reports genuine ADB read failures',async t=>{
 const {runtime}=fixture(t,{readFails:true});
 await assert.rejects(runtime.close(),error=>error.code==='RUNTIME_CLEANUP_FAILED'&&error.cleanup_codes.includes('ADB_COMMAND_FAILED'));
 assert.ok(runtime.ownedServer);
});

test('cleanup accepts a failed kill only after confirming the owned process exited',async t=>{
 const {runtime}=fixture(t,{exitAfterKill:true,killFails:true});
 await runtime.close();assert.equal(runtime.ownedServer,null);
});

test('cleanup cannot ignore a failed kill while the owned process is still alive',async t=>{
 const {runtime}=fixture(t,{exitAfterKill:true,killFails:true,processStillAlive:true});
 await assert.rejects(runtime.close(),{code:'RUNTIME_CLEANUP_FAILED'});
 assert.ok(runtime.ownedServer);
});

test('cleanup gateway refuses mismatched process proof and arbitrary shell commands',async t=>{
 const {gateway,lease,commands}=fixture(t);
 for(const command of ['cat /proc/123/stat 2>/dev/null || test ! -d /proc/456',
  'cat /proc/123/stat 2>/dev/null || true','cat /proc/123/stat',
  'cat /proc/123/stat 2>/dev/null || test ! -d /proc/123; input tap 1 1']){
  await assert.rejects(gateway.executeTrusted(lease,{args:['shell','su','-c',`'${command}'`]},{cleanup:true}),{code:'RUNTIME_CLEANUP_UNSUPPORTED'});
 }
 assert.equal(commands.length,0);
});
