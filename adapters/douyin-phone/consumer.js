'use strict';
const {AndroidAdb}=require('./android_adb');
const {harvest,resolve}=require('./harvest');
const error=code=>Object.assign(Error(code),{code,scope:'device'});
class DouyinPhoneAdapter {
 constructor({gateway,store,harvestImpl=harvest}={}){this.gateway=gateway;this.store=store;this.harvest=harvestImpl;this.version='douyin-phone-poi-queue-v1';}
 async execute(ctx){
  if(ctx.claim.payload.operation!=='place.posts')throw error('UNSUPPORTED_OPERATION');
  const {params}=ctx.claim.payload, locator=params.locator||{};
  if(!Array.isArray(locator.names)||!locator.names.length||locator.names.some(n=>typeof n!=='string'||n.length>200)||locator.names.length>20)throw error('INVALID_PLACE_LOCATOR');
  const device=this.store.devices().find(d=>d.id===ctx.claim.device_id);if(!device?.serial)throw error('DEVICE_REQUIRED');
  const fetchImpl=(url,options={})=>fetch(url,{...options,signal:AbortSignal.any([ctx.signal,...(options.signal?[options.signal]:[])])});
  let video=locator.seed_post||'';
  if(video&&!/^\d{15,22}$/.test(video)){ctx.guard();video=(await resolve(video,fetchImpl))?.id;if(!video)throw error('SEED_UNREADABLE');}
  const worker={queue:true,client:{},clipboardPort:device.clipboard_port,command:async(serial,args)=>{
    if(serial!==device.serial)throw error('DEVICE_IDENTITY_MISMATCH');
    return ctx.input(()=>this.gateway.execute(ctx.claim.lease,{serial,args},{signal:ctx.signal}));
  }};
  const adb=new AndroidAdb(device.serial,{worker,env:{CRAWLER_DEVICE_LOCK_MODE:'queue'},signal:ctx.signal});
  const seen=new Set(ctx.resume.seen_ids||[]);let storeName='';
  const checkpoint=()=>({binding:ctx.resume.binding,device_id:ctx.claim.device_id,adapter_version:this.version,cursor:null,seen_ids:[...seen]});
  try{
   await this.harvest(adb,{video,names:locator.names,max:params.max_items||200,fetchImpl,
    since:params.published_after?params.published_after.slice(0,10):'',knownIds:[...seen],
    emit:event=>{ctx.guard();if(event.event==='sheet')storeName=event.store;
     if(event.event==='post'){seen.add(event.video_id);ctx.commit({items:[{key:'post:'+event.video_id,value:{phase:'result',transport:'android_ui',observed_at:new Date().toISOString(),data:{...event,store:storeName,evidence_kind:'location_candidate_ui'}}}],checkpoint:checkpoint()});}
     if(event.event==='done')ctx.commit({items:[{key:'completion',value:{phase:'completion',data:event,observed_at:new Date().toISOString()}}],checkpoint:checkpoint()});
    }});
  }catch(e){if(e.code)throw e;throw error('DOUYIN_PHONE_COLLECTION_FAILED');}
 }
 async close(){}
}
module.exports={DouyinPhoneAdapter};
