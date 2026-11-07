'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const fail=code=>Object.assign(Error(code),{code,scope:'device'});
// Extracted from the previous bridge. No App service invocation lives here.
function foregroundMainPid(activity,candidates){
 const resumed=[...activity.matchAll(/mResumedActivity:\s*ActivityRecord\{(\S+)\s+[^\n]*?com\.xingin\.xhs\//g)].map(m=>m[1]);
 if(new Set(resumed).size!==1)return null;
 const headers=[...activity.matchAll(/^\s*\* Hist #\d+: ActivityRecord\{(\S+)[^\n]*/gm)],found=new Set();
 for(let i=0;i<headers.length;i++){
  if(headers[i][1]!==resumed[0])continue;
  const block=activity.slice(headers[i].index+headers[i][0].length,headers[i+1]?.index??activity.length);
  for(const match of block.matchAll(/^\s*app=ProcessRecord\{\S+\s+(\d+):com\.xingin\.xhs\//gm))if(candidates.includes(match[1]))found.add(match[1]);
 }
 return found.size===1?[...found][0]:null;
}
function processStart(stat){const tail=stat.slice(stat.lastIndexOf(')')+1).trim().split(/\s+/);return /^\d+$/.test(tail[19]||'')?tail[19]:null;}
class PhoneRuntime {
 constructor(adb,{binary,sha256,devicePath='/data/local/tmp/xhs-lab-frida-16.7.19',devicePort=27043,contract,cleanupAdb=adb,now=Date.now}={}){
  if(!adb?.serial)throw fail('DEVICE_REQUIRED');
  if(!/^\/data\/local\/tmp\/[a-zA-Z0-9_.-]+$/.test(devicePath)||!Number.isInteger(devicePort)||devicePort<1||devicePort>65535||!/^[a-f0-9]{64}$/.test(sha256||''))throw fail('INVALID_RUNTIME_CONFIG');
  if(contract?.package!=='com.xingin.xhs'||typeof contract.version!=='string')throw fail('INVALID_APP_CONTRACT');
  this.adb=adb;this.cleanupAdb=cleanupAdb;this.binary=path.resolve(binary);this.sha256=sha256;this.devicePath=devicePath;this.devicePort=devicePort;this.contract=contract;this.now=now;this.forward=null;this.ownedServer=null;
 }
 async root(command,adb=this.adb){return adb.command(['shell','su','-c',`'${command}'`]);}
 async pidof(name,adb=this.adb){
  try{return (await adb.shell('pidof',name)).trim();}
  catch(error){if(['LEASE_LOST','DEVICE_CONTROL_LOST','STOP_REQUESTED'].includes(error.code))throw error;return '';}
 }
 async verifyApp(){
  const info=await this.adb.shell('dumpsys','package',this.contract.package);
  if(info.match(/\bversionName=([^\s]+)/)?.[1]!==this.contract.version)throw fail('APP_VERSION_MISMATCH');
  const paths=(await this.adb.shell('pm','path',this.contract.package)).trim().split(/\r?\n/).map(x=>x.replace(/^package:/,''));
  const base=paths.filter(p=>p.endsWith('/base.apk'));
  if(base.length!==1||!/^\/[A-Za-z0-9_./=+~-]+$/.test(base[0]))throw fail('APP_PACKAGE_UNAVAILABLE');
  const hash=(await this.root(`sha256sum ${base[0]}`)).trim().split(/\s+/)[0];
  if(!/^[a-f0-9]{64}$/.test(hash))throw fail('APP_DIGEST_UNAVAILABLE');
  this.app={version:this.contract.version,apk_sha256:hash,known_build:hash===this.contract.apk_sha256||Object.hasOwn(this.contract.known_apk_sha256||{},hash)};
  return this.app;
 }
 async ensure(){
  if(!(await this.adb.devices()).some(d=>d.serial===this.adb.serial&&d.state==='device'))throw fail('DEVICE_UNAVAILABLE');
  await this.verifyApp();
  if(crypto.createHash('sha256').update(fs.readFileSync(this.binary)).digest('hex')!==this.sha256)throw fail('RUNTIME_DIGEST_MISMATCH');
  const present=(await this.root(`if [ -f ${this.devicePath} ]; then sha256sum ${this.devicePath}; fi`)).trim();
  if(present&&present.split(/\s+/)[0]!==this.sha256)throw fail('DEVICE_RUNTIME_DIGEST_MISMATCH');
  if(!present)await this.adb.command(['push',this.binary,this.devicePath]);
  await this.root(`chmod 700 ${this.devicePath}`);
  const name=path.posix.basename(this.devicePath);let pid=await this.pidof(name);
  if(!pid){
   await this.root(`${this.devicePath} -l 127.0.0.1:${this.devicePort} -P --policy-softener=internal > ${this.devicePath}.log 2>&1 < /dev/null &`);
   for(let i=0;i<20;i++){pid=await this.pidof(name);if(/^\d+$/.test(pid))break;await this.adb.wait(250);}
   if(!/^\d+$/.test(pid))throw fail('FRIDA_START_FAILED');
   const start=processStart(await this.root(`cat /proc/${pid}/stat`));
   if(!start)throw fail('RUNTIME_PROCESS_IDENTITY_UNAVAILABLE');
   this.ownedServer={pid,start};
  }else if(!/^\d+$/.test(pid))throw fail('RUNTIME_PROCESS_AMBIGUOUS');
  const forwards=await this.adb.command(['forward','--list'],{device:false});
  if(this.forward&&!forwards.split('\n').some(line=>{const [serial,local,remote]=line.trim().split(/\s+/);return serial===this.adb.serial&&local===`tcp:${this.forward}`&&remote===`tcp:${this.devicePort}`;}))this.forward=null;
  if(!this.forward){
   this.forward=Number((await this.adb.command(['forward','tcp:0',`tcp:${this.devicePort}`])).trim());
   if(!Number.isInteger(this.forward)||this.forward<1||this.forward>65535){this.forward=null;throw fail('FORWARD_FAILED');}
  }
  await this.adb.shell('monkey','-p',this.contract.package,'-c','android.intent.category.LAUNCHER','1');
  const deadline=this.now()+10000;
  while(this.now()<deadline){
   const candidates=(await this.pidof(this.contract.package)).split(/\s+/);
   const appPid=foregroundMainPid(await this.adb.shell('dumpsys','activity','activities'),candidates);
   if(appPid){
    const cmdline=await this.adb.shell('cat',`/proc/${appPid}/cmdline`);
    if(cmdline.split('\0',1)[0]!==this.contract.package)throw fail('APP_MAIN_PROCESS_MISMATCH');
    return {pid:Number(appPid),endpoint:`127.0.0.1:${this.forward}`,app:this.app};
   }
   await this.adb.wait(250);
  }
  throw fail('APP_NOT_READY');
 }
 async close(){
  // The caller keeps its device lease through cleanup. A supervisor may provide
  // a lease-only cleanupAdb so cancellation cannot suppress owned cleanup.
  const errors=[];
  if(this.forward){try{await this.cleanupAdb.command(['forward','--remove',`tcp:${this.forward}`]);this.forward=null;}catch(error){errors.push(error);}}
  if(this.ownedServer){
   try{
    const {pid,start}=this.ownedServer,current=(await this.pidof(path.posix.basename(this.devicePath),this.cleanupAdb)).split(/\s+/);
    if(current.includes(pid)&&processStart(await this.root(`cat /proc/${pid}/stat`,this.cleanupAdb))===start){
     await this.root(`kill ${pid}`,this.cleanupAdb);
     let stopped=false;
     for(let n=0;n<20;n++){
      const live=(await this.pidof(path.posix.basename(this.devicePath),this.cleanupAdb)).split(/\s+/);
      if(!live.includes(pid)){stopped=true;break;}
      if(processStart(await this.root(`cat /proc/${pid}/stat`,this.cleanupAdb))!==start){stopped=true;break;}
      await this.cleanupAdb.wait(100);
     }
     if(!stopped)throw fail('RUNTIME_STOP_UNCONFIRMED');
    }
    this.ownedServer=null;
   }catch(error){errors.push(error);}
  }
  if(errors.length){const error=fail('RUNTIME_CLEANUP_FAILED');error.cleanup_codes=errors.map(e=>e.code||e.constructor.name);throw error;}
 }
}
module.exports={PhoneRuntime,foregroundMainPid,processStart};
