'use strict';
const fs=require('node:fs'),path=require('node:path');
const {Store}=require('./store');const {createServer}=require('./server');
const enabled=value=>value==='true'||value==='1';
async function start({env=process.env,listen=true}={}){
 const root=path.resolve(env.CRAWLER_RUNTIME_DIR||'runtime');fs.mkdirSync(root,{recursive:true,mode:0o700});
 if(!env.CRAWLER_SERVICE_TOKEN_FILE)throw Object.assign(Error('SERVICE_TOKEN_REQUIRED'),{code:'SERVICE_TOKEN_REQUIRED'});
 const token=fs.readFileSync(env.CRAWLER_SERVICE_TOKEN_FILE,'utf8').trim();
 if(token.length<32)throw Object.assign(Error('SERVICE_TOKEN_REQUIRED'),{code:'SERVICE_TOKEN_REQUIRED'});
 const store=new Store(path.join(root,'queue.db'));
 let barrier,gateway,inventory,scheduler,server,closing;
 const close=()=>{
  if(closing)return closing;
  closing=(async()=>{
   const errors=[];const attempt=async fn=>{try{await fn();}catch(e){errors.push(e);}};
   // Stop accepting work immediately, drain input before freeing legacy barrier.
   const stopped=server?.listening?new Promise(resolve=>server.close(resolve)):Promise.resolve();
   await Promise.all([attempt(()=>inventory?.close()),attempt(()=>scheduler?.close()),attempt(()=>gateway?.close())]);
   server?.closeAllConnections();await stopped;
   // Local ADB close does not prove remote input stopped. Retain the guardian
   // until an operator confirms recovery; legacy tools do not read quarantine.
   const recoveryRequired=!!gateway?.requiresRecovery();
   if(!errors.length&&!recoveryRequired)await attempt(()=>barrier?.release());
   store.close();
   if(recoveryRequired)throw Object.assign(Error('DEVICE_RECOVERY_REQUIRED'),{code:'DEVICE_RECOVERY_REQUIRED'});
   if(errors.length)throw Object.assign(Error('SERVICE_DRAIN_FAILED'),{code:'SERVICE_DRAIN_FAILED'});
  })();return closing;
 };
 try{
  if(enabled(env.CRAWLER_DEVICE_GATEWAY_ENABLED)){
   const {LegacyBarrier}=require('./legacy_barrier'),{DeviceGateway}=require('./device_gateway');
   barrier=new LegacyBarrier(env.CRAWLER_LEGACY_ANDROID_LOCK_DIR);await barrier.acquire();
   gateway=new DeviceGateway(store,{adbPath:env.ADB_PATH||'adb',beforeCommand:()=>barrier.assert()});
  }
  if(gateway||enabled(env.CRAWLER_DEVICE_DISCOVERY_ENABLED)){
   const {DeviceInventory}=require('./device_inventory');inventory=new DeviceInventory(store,{adbPath:env.ADB_PATH||'adb'});await inventory.refresh();inventory.start();
  }
  // Phase 2 enables scheduling but does not advertise any live collector.
  // Real adapters enter only after their later-phase capability verification.
  const {Scheduler}=require('./scheduler');scheduler=new Scheduler(store,new Map());scheduler.start();
  server=createServer({store,token,gateway,inventory,scheduler,barrier});
  const port=Number(env.CRAWLER_PORT||18323);if(!Number.isInteger(port)||port<1||port>65535)throw Object.assign(Error('INVALID_PORT'),{code:'INVALID_PORT'});
  if(listen)await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return {store,server,gateway,inventory,scheduler,close};
 }catch(error){await close().catch(()=>{});throw error;}
}
function run(){return start().then(service=>{
 process.stdout.write('Crawler backend listening; live collectors are not enabled\n');
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>service.close().catch(error=>{process.stderr.write((error.code||'SERVICE_DRAIN_FAILED')+'\n');process.exitCode=1;}));
 return service;
}).catch(error=>{process.stderr.write((error.code||'SERVICE_START_FAILED')+'\n');process.exitCode=1;});}
if(require.main===module)run();
module.exports={start,run};
