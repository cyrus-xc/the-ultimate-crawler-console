'use strict';
const fs=require('node:fs'),path=require('node:path');
const {Store}=require('./store');const {createServer}=require('./server');
const enabled=value=>value==='true'||value==='1';
async function start({env=process.env,listen=true}={}){
 env={...env};
 const root=path.resolve(env.CRAWLER_RUNTIME_DIR||'runtime');fs.mkdirSync(root,{recursive:true,mode:0o700});
 const deviceControl=enabled(env.CRAWLER_DEVICE_GATEWAY_ENABLED);
 const {LegacyBarrier}=require('./legacy_barrier');
 const barrier=new LegacyBarrier(deviceControl?env.CRAWLER_LEGACY_ANDROID_LOCK_DIR:root,root);
 await barrier.acquire();
 let store,gateway,inventory,scheduler,server,closing,displays,desktop,registrationTimer,provisioner,connectionRecovery,warmup,webActivity,pacer=null;
 const close=()=>{
  if(closing)return closing;
  closing=(async()=>{
   clearInterval(registrationTimer);const errors=[];const attempt=async fn=>{try{await fn();}catch(e){errors.push(e);}};
   // Stop accepting work and drain writers before returning their allocations.
   const stopped=server?.listening?new Promise(resolve=>server.close(resolve)):Promise.resolve();
   await attempt(()=>connectionRecovery?.close());
   await attempt(()=>warmup?.close());
   await attempt(()=>webActivity?.close());
   await Promise.all([attempt(()=>desktop?.close()),attempt(()=>displays?.close()),attempt(()=>inventory?.close())]);
   await attempt(()=>server?.drainDesktop?.());
   await attempt(()=>scheduler?.close());
   for(const adapter of scheduler?.worker?.adapters?.values()||[])await attempt(()=>adapter.close?.());
   await attempt(()=>gateway?.close());
   server?.closeAllConnections();await stopped;
   await attempt(()=>store?.resetAllocations());
   await attempt(()=>store?.close());
   await attempt(()=>barrier.release());
   if(errors.length)throw Object.assign(Error('SERVICE_DRAIN_FAILED'),{code:'SERVICE_DRAIN_FAILED'});
  })();return closing;
 };
 try{
  store=new Store(path.join(root,'queue.db'));
  store.modes=new (require('./device_modes').DeviceModes)(store);
  store.resetAllocations();
  if(!env.CRAWLER_SERVICE_TOKEN_FILE)throw Object.assign(Error('SERVICE_TOKEN_REQUIRED'),{code:'SERVICE_TOKEN_REQUIRED'});
  const token=fs.readFileSync(env.CRAWLER_SERVICE_TOKEN_FILE,'utf8').trim();
  if(token.length<32)throw Object.assign(Error('SERVICE_TOKEN_REQUIRED'),{code:'SERVICE_TOKEN_REQUIRED'});
  if(deviceControl){
   const {DeviceGateway}=require('./device_gateway');
   const {createInputLog}=require('./input_log');
   gateway=new DeviceGateway(store,{adbPath:env.ADB_PATH||'adb',rootInputSerials:(env.CRAWLER_ROOT_INPUT_SERIALS||'').split(',').filter(Boolean),inputLog:createInputLog(path.join(root,'input-log')),beforeCommand:()=>barrier.assert()});
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
   registerPhoneAdapters({store,gateway,adapters,config:phoneSettings,selectorRoot:path.join(root,'selectors'),stateDir:root});
   for(const configured of phoneSettings?.devices||[]){
    const utilityCapabilities=uiCapabilities(configured);
    if(configured.douyin_poi!==true&&!utilityCapabilities.length)continue;
    const device=store.devices().find(d=>d.serial===configured.serial);if(!device||device.owner)continue;
    const xhs=adapters.get(device.id);if(!xhs||xhs.phoneMultiplex)continue;
    const {DouyinPhoneAdapter}=require('../adapters/douyin-phone/consumer'),douyin=new DouyinPhoneAdapter({store,gateway});
    const {AndroidUiAdapter}=require('../adapters/android-ui/consumer'),utility=new AndroidUiAdapter({store,gateway});
    store.register({id:device.id,kind:'android',serial:device.serial,capabilities:[...device.capabilities,...(configured.douyin_poi?[{platform:'douyin',operation:'place.posts'}]:[]),...utilityCapabilities]});
    adapters.set(device.id,{phoneMultiplex:true,version:xhs.version+'+douyin-poi',execute:ctx=>(ctx.claim.payload.operation==='place.search'||ctx.claim.payload.params.native_request?.representation==='ui_identity'||ctx.claim.payload.params.native_request?.kind==='location_page'?utility:ctx.claim.payload.platform==='douyin'?douyin:xhs).execute(ctx),close:async()=>{await xhs.close?.();await douyin.close?.();}});
   }
  };
  registerPhones();if(phoneSettings){registrationTimer=setInterval(()=>{try{registerPhones();}catch{}},5000);registrationTimer.unref();}
  if(gateway){
   const {ConnectionRecovery}=require('./connection_recovery');
   connectionRecovery=new ConnectionRecovery(store,gateway,inventory,{hasDisplay:id=>displays.usesDevice(id)}).start();
  }
  // CRAWLER_PACING_PROFILE (config/pacing.json) enables per-device pacing.
  if(env.CRAWLER_PACING_PROFILE){const {Pacer,loadProfile}=require('./pacer');pacer=new Pacer(store,loadProfile(env.CRAWLER_PACING_PROFILE));}
  scheduler=new Scheduler(store,adapters,{pacer});scheduler.start();
  if(gateway){
   const {PhoneWarmup}=require('./phone_warmup');
   const {warmupBrowser}=require('../adapters/xhs-phone/warmup');
   warmup=new PhoneWarmup(store,gateway,{
    browse:warmupBrowser(store,gateway),
    // With a pacing profile, warm-up runs as daytime sessions and in pacing breaks.
    pacer,sessions:!!pacer,
    onError:error=>process.stderr.write((error.code||'WARMUP_SCHEDULER_FAILED')+'\n'),
   }).start();
  }
  // Web activity (browse in breaks, approved follows/posts) needs a pacing profile.
  if(pacer&&env.CRAWLER_WEB_ACTIVITY!=='0'){
   const {WebActivity}=require('./web_activity');
   webActivity=new WebActivity(store,adapters,{pacer,onError:error=>process.stderr.write((error.code||'WEB_ACTIVITY_FAILED')+String.fromCharCode(10))}).start();
  }
  server=createServer({store,token,gateway,inventory,scheduler,barrier,displays,provisioner,connectionRecovery,warmup,pacer,webActivity});
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
