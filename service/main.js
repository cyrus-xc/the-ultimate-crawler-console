'use strict';
const fs=require('node:fs'),path=require('node:path');
const {Store}=require('./store');const {createServer}=require('./server');
const enabled=value=>value==='true'||value==='1';
async function start({env=process.env,listen=true}={}){
 env={...env};
 const root=path.resolve(env.CRAWLER_RUNTIME_DIR||'runtime');fs.mkdirSync(root,{recursive:true,mode:0o700});
 if(!env.CRAWLER_SERVICE_TOKEN_FILE)throw Object.assign(Error('SERVICE_TOKEN_REQUIRED'),{code:'SERVICE_TOKEN_REQUIRED'});
 const token=fs.readFileSync(env.CRAWLER_SERVICE_TOKEN_FILE,'utf8').trim();
 if(token.length<32)throw Object.assign(Error('SERVICE_TOKEN_REQUIRED'),{code:'SERVICE_TOKEN_REQUIRED'});
 const store=new Store(path.join(root,'queue.db'));
 let barrier,gateway,inventory,scheduler,server,closing,displays,desktop,registrationTimer,provisioner;
 const close=()=>{
  if(closing)return closing;
  closing=(async()=>{
   clearInterval(registrationTimer);const errors=[];const attempt=async fn=>{try{await fn();}catch(e){errors.push(e);}};
   // Stop accepting work immediately, drain input before freeing legacy barrier.
   const stopped=server?.listening?new Promise(resolve=>server.close(resolve)):Promise.resolve();
   await Promise.all([attempt(()=>desktop?.close()),attempt(()=>displays?.close()),attempt(()=>inventory?.close())]);
   await attempt(()=>server?.drainDesktop?.());
   await attempt(()=>scheduler?.close());
   for(const adapter of scheduler?.worker?.adapters?.values()||[])await attempt(()=>adapter.close?.());
   await attempt(()=>gateway?.close());
   server?.closeAllConnections();await stopped;
   // Local ADB close does not prove remote input stopped. Retain the guardian
   // until an operator confirms recovery; legacy tools do not read quarantine.
   const recoveryRequired=!!gateway?.requiresRecovery();
   if(!errors.length&&!recoveryRequired){for(const lease of store.db.prepare('SELECT * FROM leases WHERE attempt_id IS NULL').all()){if(lease.expires>store.now())await attempt(()=>store.releaseExternal(lease));}}
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
   gateway=new DeviceGateway(store,{adbPath:env.ADB_PATH||'adb',rootInputSerials:(env.CRAWLER_ROOT_INPUT_SERIALS||'').split(',').filter(Boolean),beforeCommand:()=>barrier.assert()});
   if(env.CRAWLER_CHROME_MANIFEST_FILE){const {PhoneProvisioner}=require('./phone_provisioning');provisioner=new PhoneProvisioner({store,gateway,manifestPath:env.CRAWLER_CHROME_MANIFEST_FILE});}
   const {DisplaySessions}=require('./display_sessions');displays=new DisplaySessions(store,{adbPath:env.ADB_PATH||'adb'});
  }
  if(gateway||enabled(env.CRAWLER_DEVICE_DISCOVERY_ENABLED)){
   const {DeviceInventory}=require('./device_inventory');inventory=new DeviceInventory(store,{adbPath:env.ADB_PATH||'adb'});await inventory.refresh();inventory.start();
  }
  if(env.CRAWLER_DESKTOP_STATE_FILE){const desktopState=JSON.parse(fs.readFileSync(env.CRAWLER_DESKTOP_STATE_FILE,'utf8'));if(!/^wayland-[0-9]+$/.test(desktopState.wayland_display||''))throw Object.assign(Error('DESKTOP_UNAVAILABLE'),{code:'DESKTOP_UNAVAILABLE'});env.CRAWLER_WAYLAND_DISPLAY=desktopState.wayland_display;}
  const {Scheduler}=require('./scheduler');const adapters=require('./web_adapters').registerWebAdapters(store,{env});
  const {phoneConfig,registerPhoneAdapters,uiCapabilities}=require('./phone_adapters'),phoneSettings=phoneConfig(env);
  const registerPhones=()=>{
   registerPhoneAdapters({store,gateway,adapters,config:phoneSettings,selectorRoot:path.join(root,'selectors')});
   for(const configured of phoneSettings?.devices||[]){
    const utilityCapabilities=uiCapabilities(configured);
    if(configured.douyin_poi!==true&&!utilityCapabilities.length)continue;
    const device=store.devices().find(d=>d.serial===configured.serial);if(!device||device.owner)continue;
    const xhs=adapters.get(device.id);if(!xhs||xhs.phoneMultiplex)continue;
    const {DouyinPhoneAdapter}=require('../adapters/douyin-phone/consumer'),douyin=new DouyinPhoneAdapter({store,gateway});
    const {AndroidUiAdapter}=require('../adapters/android-ui/consumer'),utility=new AndroidUiAdapter({store,gateway});
    store.register({id:device.id,kind:'android',serial:device.serial,capabilities:[...device.capabilities,...(configured.douyin_poi?[{platform:'douyin',operation:'place.posts'}]:[]),...utilityCapabilities]});
    adapters.set(device.id,{phoneMultiplex:true,version:xhs.version+'+douyin-poi',execute:ctx=>(ctx.claim.payload.operation==='place.search'||ctx.claim.payload.params.native_request?.representation==='ui_identity'?utility:ctx.claim.payload.platform==='douyin'?douyin:xhs).execute(ctx),close:async()=>{await xhs.close?.();await douyin.close?.();}});
   }
  };
  registerPhones();if(phoneSettings){registrationTimer=setInterval(()=>{try{registerPhones();}catch{}},5000);registrationTimer.unref();}
  scheduler=new Scheduler(store,adapters);scheduler.start();
  server=createServer({store,token,gateway,inventory,scheduler,barrier,displays,provisioner});
  const {DesktopControl}=require('./desktop_control');desktop=new DesktopControl(store,{token,port:Number(env.CRAWLER_VNC_PORT||15910)});desktop.attach(server);
  const port=Number(env.CRAWLER_PORT||18323);if(!Number.isInteger(port)||port<1||port>65535)throw Object.assign(Error('INVALID_PORT'),{code:'INVALID_PORT'});
  if(listen)await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return {store,server,gateway,inventory,scheduler,close};
 }catch(error){await close().catch(()=>{});throw error;}
}
function run(){return start().then(service=>{
 process.stdout.write('Crawler backend listening; registered consumers: '+service.scheduler.worker.adapters.size+'\n');
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>service.close().catch(error=>{process.stderr.write((error.code||'SERVICE_DRAIN_FAILED')+'\n');process.exitCode=1;}));
 return service;
}).catch(error=>{process.stderr.write((error.code||'SERVICE_START_FAILED')+'\n');process.exitCode=1;});}
if(require.main===module)run();
module.exports={start,run};
