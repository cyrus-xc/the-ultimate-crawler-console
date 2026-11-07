'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');const {LegacyBarrier}=require('../service/legacy_barrier');
function alive(pid){try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}}
function firstLine(child){
 return new Promise((resolve,reject)=>{
  let buffer='';const timer=setTimeout(()=>reject(Error('Test parent did not report guardian')),5000);
  child.once('error',error=>{clearTimeout(timer);reject(error);});
  child.stdout.on('data',data=>{buffer+=data.toString();const at=buffer.indexOf('\n');if(at>=0){clearTimeout(timer);try{resolve(JSON.parse(buffer.slice(0,at)));}catch(error){reject(error);}}});
  child.once('close',code=>{clearTimeout(timer);if(!buffer.includes('\n'))reject(Error('Test parent exited before reporting guardian: '+code));});
 });
}
test('service crash cannot expose a still-running device command to a legacy lock owner',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'barrier-crash-')),script=path.join(dir,'parent.cjs');let guardianPid,child;
 fs.writeFileSync(script,`const {LegacyBarrier}=require(${JSON.stringify(path.resolve(__dirname,'../service/legacy_barrier.js'))});
 (async()=>{const barrier=new LegacyBarrier(process.argv[2]);await barrier.acquire();process.stdout.write(JSON.stringify({guardianPid:barrier.guardianPid,file:barrier.file})+'\\n');setInterval(()=>{},1000);})().catch(()=>process.exit(1));`);
 t.after(async()=>{
  if(child && child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');
  // This PID was created by this test's parent and reported before it was killed.
  // Never enumerate/kill unrelated services or real ADB processes.
  if(Number.isSafeInteger(guardianPid)&&guardianPid>0&&alive(guardianPid))process.kill(guardianPid,'SIGKILL');
  await new Promise(resolve=>setTimeout(resolve,30));fs.rmSync(dir,{recursive:true,force:true});
 });
 child=spawn(process.execPath,[script,dir],{stdio:['ignore','pipe','ignore'],env:{...process.env,ENABLE_TIKHUB_NETWORK:'0',ENABLE_LLM_NETWORK:'0'}});
 const report=await firstLine(child);guardianPid=report.guardianPid;assert.ok(Number.isSafeInteger(guardianPid));assert.notEqual(guardianPid,child.pid);
 const closed=new Promise(resolve=>child.once('close',resolve));child.kill('SIGKILL');await closed;
 await new Promise(resolve=>setTimeout(resolve,50));
 assert.equal(alive(guardianPid),true);assert.equal(fs.readFileSync(report.file,'utf8'),String(guardianPid));
 // Legacy AndroidWorker treats a live numeric lock owner as busy. A fresh queue
 // service must also refuse ownership while the orphaned guardian is present.
 const competing=new LegacyBarrier(dir);await assert.rejects(competing.acquire(),{code:'LEGACY_WORKER_BUSY'});
 assert.equal(fs.readFileSync(report.file,'utf8'),String(guardianPid));
});
