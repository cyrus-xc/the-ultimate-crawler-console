'use strict';
const fs=require('node:fs'),path=require('node:path');
const {AndroidAdb,nodesFromXml}=require('../../android/android_adb');
const {UiLocator}=require('../../android/ui_locator');
const {PhoneRuntime}=require('./runtime');
const {XhsNavigation,SORT_LABELS}=require('./navigation');
const {captureResponse}=require('./capture');
const {envelope,first}=require('./projection');
const {digest}=require('../../service/contract');
const VERSION='xhs_ui_response_v1';
const NATIVE={'search.posts':'search','profile.get':'user_info','profile.posts':'user_posted','post.detail':'image_detail','post.comments':'comments','place.posts':'topic_feed'};
const failure=(code,scope='device')=>Object.assign(Error(code),{code,scope});
const SORTS={'':'general','综合':'general','最新':'time_descending','最多点赞':'popularity_descending','最多评论':'comment_descending','最多收藏':'collect_descending'};
function observedCursor(result){const data=result.response?.data||{},query=Object.fromEntries((result.request?.query||[]).map(q=>[q.name,q.value]));return {cursor:first(data,'cursor','start')||(Array.isArray(data.notes)?data.notes.at(-1)?.cursor:null)||null,page:query.page||null,page_context:data.page_context||null,search_id:data.search_id||null,request:query};}
function combinedEnvelope(result,operation,target){
 const captures=[...(result.replayed_pages||[]),result,...(result.related_pages||[])],values=captures.map(r=>envelope(r,operation,target)),value=values[0];
 if(values.length>1){
  const feeds=[],comments=[],seenFeeds=new Set(),seenComments=new Set();let observations={};
  for(const v of values){for(const f of v.data.raw.feeds||[])if(!seenFeeds.has(f.id)){feeds.push(f);seenFeeds.add(f.id);}for(const c of v.data.raw.comments?.list||[])if(!seenComments.has(c.id)){comments.push(c);seenComments.add(c.id);}observations={...(v.data.native_list_observations||{}),...observations};}
  if(values.some(v=>Array.isArray(v.data.raw.feeds)))value.data.raw.feeds=feeds;
  if(values.some(v=>v.data.raw.comments))value.data.raw.comments={list:comments};
  value.data.native_evidence=values.flatMap(v=>v.data.native_evidence||[]);
  if(Object.keys(observations).length)value.data.native_list_observations=observations;
  value.data.end_observed=values.at(-1).data.end_observed;value.data.stop_reason=values.at(-1).data.stop_reason;
 }
 value.data.native_responses=captures.map(r=>({operation:r.operation,response:r.response,request:r.request,observed_at:new Date(r.captured_at_ms).toISOString()}));
 if(result.related_errors?.length)value.data.capture_errors=result.related_errors;
 return {value,captures};
}
function epoch(v){if(typeof v==='number')return v<1e12?v*1000:v;if(typeof v==='string'&&/^\d+$/.test(v))return epoch(Number(v));const n=Date.parse(v);return Number.isFinite(n)?n:null;}
function makeTransport({gateway,store,claim,context,cleanup=false}){
 const device=store.devices().find(d=>d.id===claim.device_id);if(!device?.serial)throw failure('DEVICE_REQUIRED');
 const execute=async(_,argv)=>{
  const args=argv[0]==='-s'?argv.slice(2):argv;
  if(argv[0]==='-s'&&argv[1]!==device.serial)throw failure('DEVICE_IDENTITY_MISMATCH');
  const release=args[0]==='reverse'&&args[1]==='--remove';
  if(!cleanup&&!release)context.guard();
  // These commands are constructed by PhoneRuntime, never from request params.
  const restartApp=args.length===4&&args[0]==='shell'&&args[1]==="'am'"&&args[2]==="'force-stop'"&&args[3]==="'com.xingin.xhs'";
  const trusted=restartApp||cleanup||release||['forward','push'].includes(args[0])||args[0]==='shell'&&['su',"'su'",'pidof',"'pidof'"].includes(args[1])||args[0]==='shell'&&args[1]==="'cat'"&&/^'\/proc\/\d+\/cmdline'$/.test(args[2]||'');
  return trusted?gateway.executeTrusted(claim.lease,{args,serial:device.serial},{signal:cleanup||release?undefined:context.signal,cleanup:cleanup||release}):gateway.execute(claim.lease,{args,serial:device.serial},{signal:context.signal});
 };
 const adb=new AndroidAdb(device.serial,{execute,signal:cleanup?undefined:context.signal});
 // Discovery and forward listing are host reads, but still bound to this lease.
 adb.devices=async()=>{store.assertLease(claim.lease);return [{serial:device.serial,state:device.health==='disconnected'?'offline':'device'}];};
 adb.command=async(args,options)=>{
  if(args[0]==='forward'&&args[1]==='--list'){
   // adb accepts an explicit -s with forward --list; filter other serials.
   const result=await execute('', ['-s',device.serial,...args]);return result.stdout.split('\n').filter(line=>line.startsWith(device.serial+' ')).join('\n');
  }
  // The Android transport's legacy retry must not hide a fence failure or
  // retry an input after uncertain execution. Gateway already owns lifecycle.
  const result=await execute('', ['-s',device.serial,...args]);
  const output=String(result.stdout||'');
  if(args[0]==='shell'&&args[1]==="'cat'"&&args[2]==="'/sdcard/handygadgets-ui.xml'"){
   const texts=nodesFromXml(output).map(n=>n.text||n['content-desc']||'');
   if(texts.some(t=>/安全验证|验证码|Verification code|보안 인증|인증 코드/i.test(t)))throw failure('VERIFICATION_REQUIRED','platform');
   if(texts.some(t=>/请先登录|登录后|账号(?:已退出登录|下线提示)|Sign in|Log in|로그인/i.test(t)))throw failure('LOGIN_REQUIRED','platform');
  }
  return output;
 };
 adb.clipboardPort=device.clipboard_port;return adb;
}
class PhoneConsumer {
 constructor({store,gateway,deviceId,python,contractPath,binary,sha256,selectorRoot,verifiedOperations=[],runtimeFactory,navFactory,capture=captureResponse,transportFactory=makeTransport,timeoutSeconds=45}={}){
  if(!store||!gateway||!deviceId)throw failure('INVALID_PHONE_CONSUMER_CONFIG');
  this.store=store;this.gateway=gateway;this.deviceId=deviceId;this.python=python;this.contractPath=contractPath;this.contract=JSON.parse(fs.readFileSync(contractPath,'utf8'));
  this.binary=binary;this.sha256=sha256;this.selectorRoot=selectorRoot;this.capture=capture;this.transportFactory=transportFactory;this.timeoutSeconds=timeoutSeconds;this.verifiedOperations=new Set(verifiedOperations);
  this.runtimeFactory=runtimeFactory||((adb,cleanup)=>new PhoneRuntime(adb,{binary,sha256,contract:this.contract,cleanupAdb:cleanup}));
  this.navFactory=navFactory||((adb,guard)=>new XhsNavigation(adb,{guard,clipboardPort:adb.clipboardPort,locator:new UiLocator({serial:adb.serial,appVersion:this.contract.version,root:selectorRoot})}));
  this.version=VERSION;
 }
 async execute(context){
  const {claim}=context,{operation,params,limits}=claim.payload;
  if(!this.verifiedOperations.has(operation)||!NATIVE[operation])throw failure('PHONE_CAPABILITY_NOT_VERIFIED','item');
  if(params.filters&&Object.keys(params.filters).length)throw failure('PHONE_FILTER_UNSUPPORTED','item');
  const sort=SORTS[params.sort]||params.sort||'general';
  if(operation==='search.posts'&&!SORT_LABELS[sort])throw failure('UNSUPPORTED_SORT','item');
  if(operation==='place.posts'&&params.sort&&params.sort!=='trend')throw failure('PHONE_TOPIC_SORT_UNSUPPORTED','item');
  const adb=this.transportFactory({gateway:this.gateway,store:this.store,claim,context});
  const cleanup=this.transportFactory({gateway:this.gateway,store:this.store,claim,context,cleanup:true});
  const runtime=this.runtimeFactory(adb,cleanup),nav=this.navFactory(adb,()=>context.guard());
  let failureCaught;
  try{
   let session=await runtime.ensure();context.guard();
   let attachmentRestarted=false;
   const capture=async(native,values,trigger)=>{
    const read=()=>this.capture({python:this.python,contractPath:this.contractPath,...session,operation:native,values,privateMedia:Boolean(context.discovery),trigger:control=>context.input(()=>trigger(control)),guard:context.guard,signal:context.signal,timeoutSeconds:this.timeoutSeconds});
    try{return await read();}catch(error){
     // Attachment failed before perform_action: no UI input or response could
     // have occurred. A single ordinary App restart gives Frida a fresh PID.
     if(attachmentRestarted||error.code!=='CAPTURE_FAILED'||error.diagnostics?.stage!=='attachment'||error.diagnostics?.exception_type!=='ProcessNotRespondingError')throw error;
     attachmentRestarted=true;context.guard();session=await runtime.restartApp();context.guard();return read();
    }
   };
   let lastCommentPage,lastCommentCheckpoint;
   const seen=new Set(context.resume.seen_ids||[]),detailSeen=new Set(claim.checkpoint?.detail_seen_ids||[]),skipDetails=new Set(params.native_request?.profile_skip_ids||[]),anchors=new Set(params.native_request?.profile_anchor_ids||[]);let pages=0,noGrowth=0,profileOpened=false,profileNeedsRestore=false,firstPageRestarted=false,initialProfilePage=null,lastCursor=null,noteFailures=claim.checkpoint?.note_failures_in_row||0;
   if(operation==='profile.posts'&&params.native_request?.kind==='profile'){
    const readInfo=()=>capture('user_info',{query:{user_id:claim.target.user_id}},()=>nav.openProfile(claim.target.user_id));
    let info;
    try{info=await readInfo();}catch(error){
     const diagnostics=error.diagnostics,events=diagnostics?.events;
     const silentObserver=Array.isArray(diagnostics?.observed_requests)&&diagnostics.observed_requests.length===0
      &&events&&Number(events.observer_ready)>0&&Object.entries(events).every(([key,count])=>
       ['observer_ready','cronet_observer_ready'].includes(key)&&Number.isFinite(count)&&count>0);
     // A cached profile can produce no request at all. Only this observed
     // condition and a read-only profile check allow the shared one-shot restart.
     if(error.code!=='CAPTURE_TIMEOUT'||firstPageRestarted||!silentObserver)throw error;
     await context.input(()=>nav.assertProfile());
     firstPageRestarted=true;context.guard();session=await runtime.restartApp();context.guard();
     info=await readInfo();
    }
    initialProfilePage=info.related?.user_posted||null;
    const value=envelope(info,'profile.get',claim.target);value.phase='result';
    context.commit({items:[{key:'profile.get:'+claim.target.user_id,value}],checkpoint:{binding:context.resume.binding,device_id:claim.device_id,adapter_version:VERSION,seen_ids:[...seen],detail_seen_ids:[...detailSeen],decision:{phase:'page'}}});
    const decision=await context.waitForDecision();if(decision==='stop'||decision?.action==='stop')return;profileOpened=true;
   }
   // UI cannot inject saved opaque cursors. Each new attempt navigates to the
   // entry and replays, deduplicating already committed IDs on either device.
   for(let page=0;page<limits.max_pages;page++){
    context.guard();let trigger,values;
    if(operation==='search.posts'){
     values={query:{keyword:claim.target.keyword,sort,filters:'[]',...(page===0?{page:1}:lastCursor?.page?{page:Number(lastCursor.page)+1}:{})}};
     if(page===0){await nav.search(claim.target.keyword,{submit:false});trigger=async()=>{await nav.submitSearch();await nav.sort(sort);};}else trigger=control=>nav.nextPage(control?.responseReady,{guard:control?.guard});
    }else if(operation==='profile.get'){values={query:{user_id:claim.target.user_id}};trigger=()=>nav.openProfile(claim.target.user_id);}
    else if(operation==='profile.posts'){
     values={user_id:claim.target.user_id,...(page===0?{cursor:''}:lastCursor?.cursor?{cursor:lastCursor.cursor}:{})};
     trigger=page===0?async control=>{if(!profileOpened){await nav.openProfile(claim.target.user_id);await adb.wait(500);}await nav.firstPage(control?.responseReady,control);}:async control=>{
      // Detail deep links may return to Home, not the previous profile. Restore
      // under this page's observer so replay/prefetch responses remain visible.
      const restoring=profileNeedsRestore;
      if(restoring){await nav.restoreProfile(claim.target.user_id);profileNeedsRestore=false;}
      await nav.nextPage(control?.responseReady,{maxSwipes:restoring?Math.min(12*(pages+1),120):12,guard:control?.guard});
     };
    }
    else if(operation==='post.detail'){values={note_id:claim.target.post_id};trigger=context.discovery?control=>nav.openDiscoveryCard(context.discovery,control):()=>nav.openNote(claim.target.post_id);}
    else if(operation==='post.comments'){
     values={note_id:claim.target.post_id,...(page===0?{start:''}:lastCursor?.cursor?{start:lastCursor.cursor}:{})};
     if(page===0){trigger=async control=>{if(context.discovery)await nav.openDiscoveryCard(context.discovery,control);else await nav.openNote(claim.target.post_id);await adb.wait(500);await nav.comments();};}else trigger=control=>nav.nextPage(control?.responseReady,{guard:control?.guard});
    }else {values={page_id:claim.target.place_id};trigger=page===0?()=>nav.openPlace(claim.target.observed_url):control=>nav.nextPage(control?.responseReady,{guard:control?.guard});}
    let result;
    try{result=page===0&&operation==='profile.posts'&&initialProfilePage?initialProfilePage:await capture(NATIVE[operation],values,trigger);}
    catch(error){
     if(operation==='post.comments'&&error.code==='PHONE_PAGE_RESPONSE_UNOBSERVED'&&lastCommentPage&&seen.size>0){
      const partial={...lastCommentPage,data:{...lastCommentPage.data,raw:{comments:{list:[]}},end_observed:false,comments_complete:false,comment_error:error.code,stop_reason:'phone_page_response_unobserved'}};
      context.commit({items:[{key:'post.comments:partial:'+claim.target.post_id,value:partial}],checkpoint:lastCommentCheckpoint});
      await context.waitForDecision();break;
     }
     // A warm profile may satisfy navigation from App cache without exposing a
     // first-page response. One ordinary restart refreshes it; never use this
     // recovery for login, verification, or later-page failures.
     if(operation!=='profile.posts'||page!==0||firstPageRestarted||error.code!=='PHONE_FIRST_PAGE_UNOBSERVED')throw error;
     firstPageRestarted=true;context.guard();session=await runtime.restartApp();context.guard();
     profileOpened=false;initialProfilePage=null;
     result=await capture(NATIVE[operation],values,trigger);
    }
    if(operation==='search.posts'&&page===0)nav.confirmSortResponse(result.effective_sort);
    if(operation==='post.detail'&&context.discovery){await nav.back();await nav.assertDiscoveryProfile(context.discovery);}
    const {value,captures}=combinedEnvelope(result,operation,claim.target);value.phase='result';lastCursor=observedCursor(captures.at(-1));
    const records=value.data.raw.feeds||value.data.raw.comments?.list||[];
    // Disconnected observations are preserved above, but cannot prove that
    // this sequential walk reached a date or anchor on its forward path.
    const progressRecords=[result,...(result.related_pages||[])].flatMap(r=>{const v=envelope(r,operation,claim.target);return v.data.raw.feeds||v.data.raw.comments?.list||[];});
    const progressCards=new Map(progressRecords.map(r=>[String(r.id),r.noteCard]));
    const ids=records.map(r=>String(r.id||'')).filter(Boolean),newIds=ids.filter(id=>!seen.has(id));ids.forEach(id=>seen.add(id));
    // Replay packets remain evidence/candidates, but only the matched page
    // and its contiguous successors consume the forward collection budget.
    pages+=1+(result.related_pages||[]).length;noGrowth=newIds.length?0:noGrowth+1;
    const beforeSince=params.published_after&&progressRecords.some(r=>r.noteCard?.interactInfo?.sticky===false&&epoch(r.noteCard.time)!==null&&epoch(r.noteCard.time)<Date.parse(params.published_after));
    const anchorReached=operation==='profile.posts'&&progressRecords.some(r=>anchors.has(String(r.id)));
    if(!value.data.end_observed){
     if(anchorReached)value.data.stop_reason='anchor_reached';
     else
     if(params.max_items&&seen.size>=params.max_items)value.data.stop_reason='target_loaded';
     else if(beforeSince)value.data.stop_reason='since_reached';
    }
    const checkpoint={binding:context.resume.binding,device_id:claim.device_id,adapter_version:VERSION,cursor:lastCursor,seen_ids:[...seen],detail_seen_ids:[...detailSeen],note_failures_in_row:noteFailures,pages_read:pages,ui_resume:'replay_deduplicate',decision:{phase:'page'}};
    if(operation==='post.comments'){lastCommentPage=value;lastCommentCheckpoint=checkpoint;}
    context.commit({items:[{key:operation+':'+digest(ids.length?ids:claim.target),value}],checkpoint});
    const decision=await context.waitForDecision();if(decision==='stop'||decision?.action==='stop')break;
    if(result.related_errors?.length)throw failure(result.related_errors[0],result.related_errors[0]==='LOGIN_OR_VERIFICATION_REQUIRED'?'platform':'device');
    // Native profile callbacks historically read each note before deciding.
    // The full loaded page was committed above; unread candidates cannot vanish.
    if(operation==='profile.posts'&&claim.payload.continuation?.mode==='manual'){
     for(const id of ids){
      if(progressCards.has(id)&&anchors.has(id))return;
      const card=progressCards.get(id),since=params.published_after?Date.parse(params.published_after):epoch(params.native_request?.since);
      if(since&&card?.interactInfo?.sticky===false&&epoch(card.time)!==null&&epoch(card.time)<since)return;
      if(detailSeen.has(id)||skipDetails.has(id))continue;
      let detail;
      try{
       profileNeedsRestore=true;
       const detailResult=await capture('image_detail',{note_id:id},()=>nav.openNote(id));
       detail=envelope(detailResult,'post.detail',{post_id:id});noteFailures=0;
      }catch(error){
       if(!['NATIVE_OPERATION_UNAVAILABLE','NATIVE_NOTE_IDENTITY_MISMATCH','NATIVE_DETAIL_IDENTITY_MISMATCH','NATIVE_DETAIL_BODY_UNOBSERVED'].includes(error.code))throw error;
       noteFailures++;detailSeen.add(id);
       const unread={phase:'result',success:true,provider:'native_phone',transport:'native_phone',observed_at:value.observed_at,data:{raw:{feeds:[]},unread_notes:[{note_id:id,reason:error.code}],observed_at:value.observed_at,end_observed:false,stop_reason:noteFailures>=3?'native_note_failures_in_row':'native_note_unread'}};
       context.commit({items:[{key:'unread:'+id,value:unread}],checkpoint:{...checkpoint,detail_seen_ids:[...detailSeen],note_failures_in_row:noteFailures,decision:{phase:'page'}}});
       const d=await context.waitForDecision();if(d==='stop'||d?.action==='stop'||noteFailures>=3)return;
       continue;
      }detail.phase='profile_note';detail.note_id=id;detailSeen.add(id);
      const next={...checkpoint,detail_seen_ids:[...detailSeen],note_failures_in_row:noteFailures,decision:{phase:'profile_note',subject_id:id}};
      context.commit({items:[{key:'profile_note:'+id,value:detail}],checkpoint:next});
      const d=await context.waitForDecision();if(d==='stop'||d?.action==='stop')return;

     }
    }
    if(['profile.get','post.detail'].includes(operation)||value.data.end_observed||anchorReached)break;
    if((params.max_items&&seen.size>=params.max_items)||pages>=limits.max_pages)break;
    // Keep the entire page. Only stop on an affirmatively dated non-pinned row.
    if(beforeSince)break;
    if(noGrowth>=2)throw failure('PHONE_PAGINATION_STALLED','device');
   }
   if(operation==='post.comments'&&context.discovery){
    await nav.back();
    try{await nav.assertDiscoveryProfile(context.discovery);}catch(error){if(error.code!=='PROFILE_RESTORE_UNCONFIRMED')throw error;await nav.back();await nav.assertDiscoveryProfile(context.discovery);}
   }
  }catch(error){failureCaught=error;if(['ACCOUNT_REQUIRED','LOGIN_OR_VERIFICATION_REQUIRED','LOGIN_REQUIRED','VERIFICATION_REQUIRED','APP_VERSION_MISMATCH'].includes(error.code))error.scope='platform';throw error;}
  finally{
   try{await this.gateway.drain(claim.lease);await runtime.close();await this.gateway.drain(claim.lease);}
   catch(error){this.store.quarantine(claim.device_id,'RUNTIME_CLEANUP_FAILED');if(failureCaught)failureCaught.cleanup_codes=error.cleanup_codes||[error.code];else throw error;}
  }
 }
}
module.exports={PhoneConsumer,makeTransport,observedCursor,combinedEnvelope,VERSION,NATIVE};
