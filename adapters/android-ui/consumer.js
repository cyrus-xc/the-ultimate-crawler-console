'use strict';
const {AndroidAdb}=require('../douyin-phone/android_adb');
const {lookup}=require('./venue_lookup');
const {recoverLink}=require('./link_recovery');
const {inspectPost}=require('../douyin-phone/harvest');
const fail=code=>Object.assign(Error(code),{code,scope:'device'});
class AndroidUiAdapter {
 constructor({gateway,store,lookupImpl=lookup,recoverImpl=recoverLink,inspectImpl=inspectPost}={}){Object.assign(this,{gateway,store,lookup:lookupImpl,recover:recoverImpl,inspect:inspectImpl});this.version='android-ui-identity-v1';}
 async execute(ctx){
  const {platform,operation,params}=ctx.claim.payload,t=ctx.claim.target;
  if(!(operation==='place.search'&&platform==='xiaohongshu')&&!(operation==='post.detail'&&params.native_request?.representation==='ui_identity'))throw fail('UNSUPPORTED_OPERATION');
  const device=this.store.devices().find(d=>d.id===ctx.claim.device_id);if(!device?.serial)throw fail('DEVICE_REQUIRED');
  const worker={queue:true,clipboardPort:device.clipboard_port,client:{devices:async()=>({devices:[{kind:'android',serial:device.serial,connection_state:'device'}]})},
   acquire:async serial=>{ctx.guard();if(serial!==device.serial)throw fail('DEVICE_IDENTITY_MISMATCH');},release:async()=>{},
   command:async(serial,args)=>{if(serial!==device.serial)throw fail('DEVICE_IDENTITY_MISMATCH');return ctx.input(()=>this.gateway.execute(ctx.claim.lease,{serial,args},{signal:ctx.signal}));}};
  const adbFactory=(serial,options={})=>new AndroidAdb(serial,{...options,worker,env:{CRAWLER_DEVICE_LOCK_MODE:'queue'},signal:ctx.signal});
  let data;
  if(operation==='place.search'){
   data=await this.lookup({platform,serial:device.serial,venue_name:t.keyword,query:t.keyword,aliases:params.locator?.names||[]},{worker,adbFactory,guard:ctx.guard});
  }else if(platform==='douyin'){
   const observation=await this.inspect(adbFactory(device.serial),{videoId:t.post_id});
   data={...observation,status:'observed',identity_scope:'note_only',evidence_kind:'ui_identity'};
  }else{
   const observation=await this.recover({input:t.observed_url||'',note_id:t.post_id},{serial:device.serial,worker,adbFactory,signal:ctx.signal});
   data={status:observation.identity_confirmed?'observed':'needs_review',note_id:observation.note_id,original:observation.share_url||null,
    poi_id:observation.poi_id||null,poi_name:observation.poi_name||null,author_uid:observation.author_uid||null,
    identity_confirmed:observation.identity_confirmed===true,author_identity_confirmed:!!observation.author_uid,
    identity_scope:'note_and_author',source:observation.method==='already_valid'?'mobile_share_page':'android_known_post',
    observed_at:observation.verified_at||new Date().toISOString(),reason:observation.reason||null,evidence_kind:'ui_identity'};
  }
  ctx.guard();ctx.commit({items:[{key:'result',value:{phase:'result',data,observed_at:data.observed_at||new Date().toISOString(),transport:'android_ui'}}],
   checkpoint:{binding:ctx.resume.binding,device_id:ctx.claim.device_id,adapter_version:this.version,cursor:null,seen_ids:[]}});
  await ctx.waitForDecision();
 }
 async close(){}
}
module.exports={AndroidUiAdapter};
