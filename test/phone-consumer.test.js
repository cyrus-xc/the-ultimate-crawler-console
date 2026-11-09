'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {Store}=require('../service/store'),{LocalWorker}=require('../service/worker');
const {PhoneConsumer}=require('../adapters/xhs-phone/consumer');
const {envelope}=require('../adapters/xhs-phone/projection');
const {registerPhoneAdapters}=require('../service/phone_adapters');
const id=n=>String(n).padStart(24,'a');
const base={schema_version:'crawler.request.v1',idempotency_key:'test',platform:'xiaohongshu',operation:'search.posts',targets:[{keyword:'词'}],params:{max_items:1},limits:{max_pages:3}};
function fixture(t,input=base){
 const store=new Store();store.register({id:'p',kind:'android',serial:'S',capabilities:[{platform:'xiaohongshu',operation:input.operation}]});
 const events=[],captures=[],gateway={drain:async()=>events.push('drain')},runtime={ensure:async()=>({pid:1,endpoint:'127.0.0.1:4000'}),close:async()=>events.push('close')};
 const nav={search:async()=>events.push('search'),submitSearch:async()=>events.push('submit'),sort:async()=>events.push('sort'),confirmSortResponse:()=>{},swipe:async()=>events.push('swipe'),openProfile:async()=>events.push('profile'),refresh:async()=>events.push('refresh'),firstPage:async()=>events.push('refresh'),nextPage:async()=>events.push('swipe'),openNote:async()=>events.push('detail'),comments:async()=>{},back:async()=>events.push('back'),restoreProfile:async()=>events.push('restore-profile'),assertProfile:async()=>events.push('assert-profile')};
 const replies=[{response:{data:{items:[{id:id(1),desc:'body',user:{userid:id(2)}}],has_more:false}}}];
 const consumer=new PhoneConsumer({store,gateway,deviceId:'p',contractPath:path.resolve(__dirname,'../contracts/xhs-app-9.51.0.json'),verifiedOperations:[input.operation],transportFactory:()=>({wait:async()=>{}}),runtimeFactory:()=>runtime,navFactory:()=>nav,capture:async options=>{captures.push(options);await options.guard();await options.trigger();const r=replies.shift();if(r instanceof Error)throw r;return {captured_at_ms:1000,status:200,operation:options.operation,request:{query:[]},effective_sort:'general',...r};}});
 const worker=new LocalWorker(store,new Map([['p',consumer]]),{heartbeatMs:5});t.after(async()=>{await worker.close();store.close();});const request=store.submit(input);return {store,worker,request,events,captures,replies,runtime,consumer};
}
test('phone consumer preserves the whole loaded page and captures only after UI input',async t=>{
 const f=fixture(t);f.replies[0].response.data.items.push({id:id(3),desc:'second'});f.worker.dispatch();await Promise.all(f.worker.active.values());
 assert.equal(f.store.request(f.request.id).state,'succeeded');const results=f.store.results(f.request.id);assert.equal(results[0].payload.data.raw.feeds.length,2);
 assert.deepEqual(f.events,['search','submit','sort','drain','close','drain']);assert.equal(f.captures[0].privateMedia,false);assert.equal(f.captures[0].values.query.keyword,'词');assert.equal(f.captures[0].values.query.page_size,undefined);
});
test('pagination reads App pages sequentially and checkpoints actual cursors',async t=>{
 const f=fixture(t,{...base,params:{max_items:10}});f.replies[0].response.data.has_more=true;f.replies[0].response.data.cursor='actual1';f.replies.push({response:{data:{items:[{id:id(3)}],has_more:false,cursor:'actual2'}}});
 f.worker.dispatch();await Promise.all(f.worker.active.values());const r=f.store.request(f.request.id);assert.equal(r.state,'succeeded');assert.equal(r.units[0].checkpoint.cursor.cursor,'actual2');assert.equal(f.events.filter(x=>x==='swipe').length,1);assert.equal(f.captures[1].values.query.page,undefined);
});
test('login failure records platform health and still drains runtime',async t=>{
 const f=fixture(t);f.replies[0]=Object.assign(Error('login'),{code:'LOGIN_OR_VERIFICATION_REQUIRED'});f.worker.dispatch();await Promise.all(f.worker.active.values());
 assert.equal(f.store.devices()[0].faults.xiaohongshu,'LOGIN_OR_VERIFICATION_REQUIRED');assert.deepEqual(f.events.slice(-3),['drain','close','drain']);
});
test('native profile decision is made on captured detail and false continues',async t=>{
 const f=fixture(t,{...base,operation:'profile.posts',targets:[{user_id:id(2)}],params:{max_items:1},continuation:{mode:'manual'}});
 f.replies[0]={response:{data:{notes:[{id:id(1),user:{userid:id(2)}}],has_more:false}}};f.replies.push({response:{data:[{note_list:[{id:id(1),desc:'detail body',user:{userid:id(2)}}]}]}});
 f.worker.dispatch();let phase;
 for(let n=0;n<100;n++){
  for(const d of f.store.request(f.request.id).decisions.filter(d=>d.action===null)){phase=d.phase;f.store.decide(f.request.id,d.id,'continue');}
  if(!f.worker.active.size)break;await new Promise(r=>setTimeout(r,5));
 }
 await Promise.all(f.worker.active.values());assert.equal(f.store.request(f.request.id).state,'succeeded');assert.equal(phase,'profile_note');assert.equal(f.store.results(f.request.id)[1].payload.data.raw.note.desc,'detail body');assert.equal(f.events.includes('back'),false);
});
test('unverified operations are never registered by mere discovery',t=>{
 const f=fixture(t);const adapters=new Map();assert.deepEqual(registerPhoneAdapters({store:f.store,gateway:f.consumer.gateway,adapters,config:null}),[]);assert.equal(adapters.size,0);
});
test('native projection keeps unknown counters unknown and validates detail identity',()=>{
 const result={captured_at_ms:1000,response:{data:[{note_list:[{id:id(1),desc:'body',user:{userid:id(2)}}]}]}};
 const value=envelope(result,'post.detail',{post_id:id(1)});assert.equal(value.data.raw.note.interactInfo.likedCount,null);assert.equal(value.data.share_status,'unavailable');assert.throws(()=>envelope(result,'post.detail',{post_id:id(3)}),{code:'NATIVE_NOTE_IDENTITY_MISMATCH'});
});
test('App tag metadata objects do not break existing native projections',()=>{
 const result={captured_at_ms:1000,response:{data:{items:[{id:id(1),hash_tag:{name:'not a tag list'},user:{userid:id(2)}}]}}};
 const value=envelope(result,'search.posts',{});assert.deepEqual(value.data.raw.feeds[0].noteCard.tagList,[]);assert.deepEqual(value.data.raw.feeds[0].noteCard._native_original.hash_tag,{name:'not a tag list'});
});
test('phone registry accepts both verified generic and native sort names',t=>{
 const f=fixture(t),adapters=new Map();registerPhoneAdapters({store:f.store,gateway:f.consumer.gateway,adapters,config:{contractPath:path.resolve(__dirname,'../contracts/xhs-app-9.51.0.json'),devices:[{serial:'S',operations:['search.posts'],sorts:['time_descending']}]}});
 assert.deepEqual(f.store.devices()[0].capabilities[0].sorts,['time_descending','最新']);
});
test('known per-note failures remain explicit and do not drop other loaded profile candidates',async t=>{
 const f=fixture(t,{...base,operation:'profile.posts',targets:[{user_id:id(2)}],params:{max_items:2},continuation:{mode:'manual'}});
 f.replies[0]={response:{data:{notes:[{id:id(1),user:{userid:id(2)}},{id:id(3),user:{userid:id(2)}}],has_more:false}}};
 f.replies.push(Object.assign(Error('unread'),{code:'NATIVE_DETAIL_BODY_UNOBSERVED'}),{response:{data:[{note_list:[{id:id(3),desc:'read second note',user:{userid:id(2)}}]}]}});
 f.worker.dispatch();for(let n=0;n<100;n++){for(const d of f.store.request(f.request.id).decisions.filter(d=>d.action===null))f.store.decide(f.request.id,d.id,'continue');if(!f.worker.active.size)break;await new Promise(r=>setTimeout(r,5));}
 await Promise.all(f.worker.active.values());const rows=f.store.results(f.request.id);assert.equal(f.store.request(f.request.id).state,'succeeded');assert.equal(rows[0].payload.data.raw.feeds.length,2);assert.deepEqual(rows[1].payload.data.unread_notes,[{note_id:id(1),reason:'NATIVE_DETAIL_BODY_UNOBSERVED'}]);assert.equal(rows[2].payload.data.raw.note.desc,'read second note');
});
test('prefetched pages are retained beyond the stopping target with the last real checkpoint',async t=>{
 const f=fixture(t,{...base,limits:{max_pages:1}});f.replies[0].response.data.has_more=true;
 f.replies[0].related_pages=[{captured_at_ms:1001,operation:'search',response:{data:{items:[{id:id(3)}],has_more:false,cursor:'prefetch-end'}},request:{query:[{name:'page',value:'2'}]}}];
 f.worker.dispatch();await Promise.all(f.worker.active.values());const r=f.store.request(f.request.id),item=f.store.results(r.id)[0].payload;
 assert.equal(r.state,'succeeded');assert.equal(item.data.raw.feeds.length,2);assert.equal(item.data.native_responses.length,2);assert.equal(r.units[0].checkpoint.cursor.cursor,'prefetch-end');assert.equal(r.units[0].checkpoint.pages_read,2);assert.equal(f.captures.length,1);
});
test('profile header prefetch flows through initial page merging and actual final cursor',async t=>{
 const f=fixture(t,{...base,operation:'profile.posts',targets:[{user_id:id(2)}],params:{max_items:2,native_request:{kind:'profile'}},limits:{max_pages:2}});
 const posted=(note,cursor,more)=>({captured_at_ms:1001,operation:'user_posted',response:{data:{notes:[{id:note,cursor,user:{userid:id(2)}}],has_more:more}},request:{query:[]}});
 const first=posted(id(1),'next',true);first.related_pages=[posted(id(3),'end',false)];
 f.replies[0]={response:{data:{userid:id(2)}},related:{user_posted:first}};
 f.worker.dispatch();await Promise.all(f.worker.active.values());const result=f.store.request(f.request.id),page=f.store.results(result.id).find(r=>r.payload.data.native_responses)?.payload;
 assert.equal(result.state,'succeeded');assert.equal(page.data.raw.feeds.length,2);assert.equal(page.data.native_responses.length,2);assert.equal(result.units[0].checkpoint.cursor.cursor,'end');assert.equal(result.units[0].checkpoint.pages_read,2);assert.equal(f.captures.length,1);assert.equal(f.events.filter(x=>x==='swipe').length,0);
});

test('manual profile details restore the target profile inside the next page observer',async t=>{
 const f=fixture(t,{...base,operation:'profile.posts',targets:[{user_id:id(2)}],params:{max_items:2},continuation:{mode:'manual'}});
 f.replies[0]={response:{data:{notes:[{id:id(1),cursor:'page-one',user:{userid:id(2)}}],has_more:true}}};
 const detail=n=>({response:{data:[{note_list:[{id:id(n),desc:'body',user:{userid:id(2)}}]}]}});
 f.replies.push(detail(1),{response:{data:{notes:[{id:id(3),cursor:'page-two',user:{userid:id(2)}}],has_more:false}}},detail(3));
 f.worker.dispatch();for(let n=0;n<100;n++){for(const d of f.store.request(f.request.id).decisions.filter(d=>d.action===null))f.store.decide(f.request.id,d.id,'continue');if(!f.worker.active.size)break;await new Promise(r=>setTimeout(r,5));}
 await Promise.all(f.worker.active.values());assert.equal(f.store.request(f.request.id).state,'succeeded');
 assert.deepEqual(f.events.slice(0,6),['profile','refresh','detail','restore-profile','swipe','detail']);
 assert.equal(f.events.includes('back'),false);assert.equal(f.captures[2].operation,'user_posted');assert.equal(f.captures[2].values.cursor,'page-one');
});
test('cached profile first page is retried once after ordinary App restart with fresh PID',async t=>{
 const f=fixture(t,{...base,operation:'profile.posts',targets:[{user_id:id(2)}]});
 f.runtime.restartApp=async()=>{f.events.push('restart');return {pid:2,endpoint:'127.0.0.1:4000'};};
 f.replies[0]=Object.assign(Error('not observed'),{code:'PHONE_FIRST_PAGE_UNOBSERVED'});
 f.replies.push({response:{data:{notes:[{id:id(1),user:{userid:id(2)}}],has_more:false}}});
 f.worker.dispatch();await Promise.all(f.worker.active.values());assert.equal(f.store.request(f.request.id).state,'succeeded');
 assert.deepEqual(f.captures.map(c=>c.pid),[1,2]);assert.equal(f.events.filter(x=>x==='restart').length,1);
 assert.equal(f.events.filter(x=>x==='profile').length,2);
});
test('nonresponsive Frida attachment restarts once before any page action',async t=>{
 const f=fixture(t);let restarts=0,calls=0;
 f.runtime.restartApp=async()=>{restarts++;return {pid:2,endpoint:'127.0.0.1:4000'};};
 f.consumer.capture=async options=>{
  calls++;f.captures.push(options);
  if(calls===1)throw Object.assign(Error('CAPTURE_FAILED'),{code:'CAPTURE_FAILED',diagnostics:{stage:'attachment',exception_type:'ProcessNotRespondingError'}});
  await options.trigger();return {captured_at_ms:1000,status:200,operation:options.operation,request:{query:[]},effective_sort:'general',response:{data:{items:[{id:id(1),desc:'body'}],has_more:false}}};
 };
 f.worker.dispatch();await Promise.all(f.worker.active.values());
 assert.equal(f.store.request(f.request.id).state,'succeeded');assert.equal(restarts,1);
 assert.deepEqual(f.captures.map(c=>c.pid),[1,2]);assert.equal(f.events.filter(x=>x==='submit').length,1);
});
test('nonresponsive attachment retries only once',async t=>{
 const f=fixture(t);let restarts=0;
 f.runtime.restartApp=async()=>{restarts++;return {pid:2,endpoint:'127.0.0.1:4000'};};
 f.consumer.capture=async()=>{throw Object.assign(Error('CAPTURE_FAILED'),{code:'CAPTURE_FAILED',scope:'device',diagnostics:{stage:'attachment',exception_type:'ProcessNotRespondingError'}});};
 f.worker.dispatch();await Promise.all(f.worker.active.values());
 assert.equal(restarts,1);assert.equal(f.store.devices()[0].health,'unavailable');assert.equal(f.store.devices()[0].owner,null);
});
test('first-page retry is bounded and never restarts on login or verification',async t=>{
 for(const code of ['PHONE_FIRST_PAGE_UNOBSERVED','LOGIN_REQUIRED','VERIFICATION_REQUIRED']){
  const f=fixture(t,{...base,operation:'profile.posts',targets:[{user_id:id(2)}]});let restarts=0;
  f.runtime.restartApp=async()=>{restarts++;return {pid:2,endpoint:'127.0.0.1:4000'};};
  f.replies.splice(0,1,...Array.from({length:2},()=>Object.assign(Error(code),{code})));
  f.worker.dispatch();await Promise.all(f.worker.active.values());assert.equal(restarts,code==='PHONE_FIRST_PAGE_UNOBSERVED'?1:0);
  assert.notEqual(f.store.request(f.request.id).state,'succeeded');
 }
});
test('replayed observations are kept without rewinding the matched-page checkpoint',async t=>{
 const f=fixture(t,{...base,operation:'profile.posts',targets:[{user_id:id(2)}],params:{max_items:1}});
 const page=(note,cursor,more=true)=>({captured_at_ms:1000,operation:'user_posted',request:{query:[]},response:{data:{notes:[{id:id(note),cursor,user:{userid:id(2)}}],has_more:more}}});
 f.replies[0]={...page(3,'matched'),replayed_pages:[page(1,'older')],related_pages:[page(4,'successor',false)]};
 f.worker.dispatch();await Promise.all(f.worker.active.values());const r=f.store.request(f.request.id),value=f.store.results(r.id)[0].payload;
 assert.equal(r.state,'succeeded');assert.equal(r.units[0].checkpoint.cursor.cursor,'successor');assert.equal(value.data.end_observed,true);
 assert.deepEqual(value.data.raw.feeds.map(x=>x.id),[id(1),id(3),id(4)]);assert.equal(value.data.native_responses.length,3);
});
test('replayed profile pages preserve candidates without spending the forward page budget',async t=>{
 const f=fixture(t,{...base,operation:'profile.posts',targets:[{user_id:id(2)}],params:{max_items:100},limits:{max_pages:3}});
 const page=(requestCursor,cursor,notes,more=true)=>({captured_at_ms:1000,operation:'user_posted',request:{query:[{name:'cursor',value:requestCursor}]},response:{data:{cursor,notes:notes.map(n=>({id:id(n),user:{userid:id(2)}})),has_more:more}}});
 f.replies.splice(0,1,page('','c1',[1]),{...page('c1','c2',[3]),replayed_pages:[page('','c1',[1,5])]},page('c2','c3',[4],false));
 f.worker.dispatch();await Promise.all(f.worker.active.values());const request=f.store.request(f.request.id),rows=f.store.results(request.id);
 assert.equal(request.state,'succeeded');assert.equal(f.captures.length,3);
 assert.deepEqual(f.captures.map(c=>c.values.cursor),['','c1','c2']);
 assert.equal(request.units[0].checkpoint.pages_read,3);assert.equal(request.units[0].checkpoint.cursor.cursor,'c3');
 assert.deepEqual(new Set(request.units[0].checkpoint.seen_ids),new Set([id(1),id(3),id(4),id(5)]));
 assert.deepEqual(rows[1].payload.data.raw.feeds.map(n=>n.id),[id(1),id(5),id(3)]);
 assert.equal(rows[1].payload.data.native_responses.length,2);
});
test('disconnected old and anchor observations do not stop the forward profile walk or manual details',async t=>{
 for(const manual of [false,true]){
  const f=fixture(t,{...base,operation:'profile.posts',targets:[{user_id:id(2)}],params:{max_items:100,published_after:'2025-01-01T00:00:00Z',native_request:{profile_anchor_ids:[id(5)]}},limits:{max_pages:2},...(manual?{continuation:{mode:'manual'}}:{})});
  const page=(n,cursor,more,time)=>({captured_at_ms:1000,operation:'user_posted',request:{query:[]},response:{data:{cursor,notes:[{id:id(n),time,is_top:false,user:{userid:id(2)}}],has_more:more}}});
  const first={...page(1,'c1',true,1800000000),replayed_pages:[page(5,'gap',false,1000000000)]};
  const second=page(3,'c2',false,1800000000);
  const detail=n=>({response:{data:[{note_list:[{id:id(n),desc:'body',user:{userid:id(2)}}]}]}});
  f.replies.splice(0,1,first,...(manual?[detail(5),detail(1)]:[]),second,...(manual?[detail(3)]:[]));
  f.worker.dispatch();
  if(manual)for(let n=0;n<150;n++){for(const d of f.store.request(f.request.id).decisions.filter(d=>d.action===null))f.store.decide(f.request.id,d.id,'continue');if(!f.worker.active.size)break;await new Promise(r=>setTimeout(r,5));}
  await Promise.all(f.worker.active.values());const request=f.store.request(f.request.id),rows=f.store.results(request.id);
  assert.equal(request.state,'succeeded');assert.equal(request.units[0].checkpoint.cursor.cursor,'c2');
  assert.equal(f.captures.filter(c=>c.operation==='user_posted').length,2);
  assert.equal(rows[0].payload.data.end_observed,false);assert.notEqual(rows[0].payload.data.stop_reason,'anchor_reached');assert.notEqual(rows[0].payload.data.stop_reason,'since_reached');
  assert.deepEqual(rows[0].payload.data.raw.feeds.map(n=>n.id),[id(5),id(1)]);
  if(manual)assert.deepEqual(f.captures.filter(c=>c.operation==='image_detail').map(c=>c.values.note_id),[id(5),id(1),id(3)]);
 }
});

const noProfileResponse=()=>Object.assign(Error('CAPTURE_TIMEOUT'),{code:'CAPTURE_TIMEOUT',diagnostics:{events:{cronet_observer_ready:1,observer_ready:1},observed_requests:[]}});
test('silent warm profile header retries once only after UI confirms profile',async t=>{
 const f=fixture(t,{...base,operation:'profile.posts',targets:[{user_id:id(2)}],params:{max_items:1,native_request:{kind:'profile'}}});
 f.runtime.restartApp=async()=>{f.events.push('restart');return {pid:2,endpoint:'127.0.0.1:4000'};};
 f.replies.splice(0,1,noProfileResponse(),{response:{data:{userid:id(2)}}},{response:{data:{notes:[{id:id(1),user:{userid:id(2)}}],has_more:false}}});
 f.worker.dispatch();await Promise.all(f.worker.active.values());assert.equal(f.store.request(f.request.id).state,'succeeded');
 assert.deepEqual(f.captures.map(c=>c.pid),[1,2,2]);assert.deepEqual(f.events.slice(0,4),['profile','assert-profile','restart','profile']);
});
test('header timeout recovery requires complete zero-response diagnostics and shares first-page restart budget',async t=>{
 const cases=[
  {error:Object.assign(Error('timeout'),{code:'CAPTURE_TIMEOUT'})},
  {error:Object.assign(noProfileResponse(),{diagnostics:{events:{observer_ready:1,response_json:1},observed_requests:[]}})},
  {error:Object.assign(noProfileResponse(),{diagnostics:{events:{observer_ready:1,cronet_observer_ready:0},observed_requests:[]}})},
  {error:Object.assign(noProfileResponse(),{diagnostics:{events:{observer_ready:1},observed_requests:[{path:'observed'}]}})},
  {error:Object.assign(noProfileResponse(),{code:'LOGIN_REQUIRED'})},
  {error:noProfileResponse(),wrongUi:true},
  {error:noProfileResponse(),afterHeader:true},
 ];
 for(const item of cases){
  const f=fixture(t,{...base,operation:'profile.posts',targets:[{user_id:id(2)}],params:{native_request:{kind:'profile'}}});let restarts=0;
  f.runtime.restartApp=async()=>{restarts++;return {pid:2,endpoint:'127.0.0.1:4000'};};
  if(item.wrongUi)f.consumer.navFactory=()=>({openProfile:async()=>{},assertProfile:async()=>{throw Object.assign(Error('wrong page'),{code:'PROFILE_RESTORE_UNCONFIRMED'});}});
  f.replies.splice(0,1,item.error,{response:{data:{userid:id(2)}}},Object.assign(Error('first page'),{code:'PHONE_FIRST_PAGE_UNOBSERVED'}));
  f.worker.dispatch();await Promise.all(f.worker.active.values());assert.equal(restarts,item.afterHeader?1:0);assert.notEqual(f.store.request(f.request.id).state,'succeeded');
 }
});
test('discovery video cards use one detail capture action and preserve the selected identity',async t=>{
 const f=fixture(t,{...base,operation:'post.detail',targets:[{post_id:id(1)}],params:{}});
 f.consumer.navFactory=()=>({openDiscoveryCard:async()=>f.events.push('card'),back:async()=>f.events.push('back'),assertDiscoveryProfile:async()=>f.events.push('profile-confirmed')});
 f.replies[0]={response:{data:[{note_list:[{id:id(1),desc:'video body',type:'video',user:{userid:id(2)}}]}]}};
 f.worker.adapters.set('p',{version:f.consumer.version,execute:ctx=>f.consumer.execute({...ctx,discovery:{card:{_raw:{noteCard:{type:'video'}}}}})});
 f.worker.dispatch();await Promise.all(f.worker.active.values());assert.equal(f.store.request(f.request.id).state,'succeeded');assert.equal(f.captures[0].operation,'image_detail');assert.equal(f.captures[0].values.note_id,id(1));assert.deepEqual(f.events.slice(0,3),['card','back','profile-confirmed']);
});

test('discovery media restores only detached normalized image fields',()=>{
 const nid=id(1),url='https://sns-img.xhscdn.com/a%2Fb?sign=private%2Bsignature',safe='https://sns-img.xhscdn.com/a/b?sign=REDACTED';
 const raw={id:nid,desc:'body',images_list:[{info_list:[{url:safe}]}],cover:{url:safe}};
 const result={operation:'user_posted',captured_at_ms:1000,response:{data:{notes:[raw]}},private_media:[{note_id:nid,path:['images_list',0,'info_list',0,'url'],url},{note_id:nid,path:['cover','url'],url}]};
 const out=envelope(result,'profile.posts',{user_id:id(2)}).data;
 assert.equal(out.raw.feeds[0].noteCard.imageList[0].info_list[0].url,url);
 assert.equal(out.raw.feeds[0].noteCard.cover.url,url);
 assert.equal(out.raw.feeds[0].noteCard._native_original.images_list[0].info_list[0].url,safe);
 assert.equal(out.response.data.notes[0].images_list[0].info_list[0].url,safe);
 assert.equal(result.response.data.notes[0].cover.url,safe);
 assert.equal(out.private_media,undefined);
});

test('discovery comments relocate the selected card and restore profile before next selection',async t=>{
 const f=fixture(t,{...base,operation:'post.comments',targets:[{post_id:id(1)}]});
 f.consumer.navFactory=()=>({openDiscoveryCard:async()=>f.events.push('card'),comments:async()=>f.events.push('comments'),back:async()=>f.events.push('back'),assertDiscoveryProfile:async()=>f.events.push('profile-confirmed')});
 f.replies[0]={response:{data:{comments:[{id:'c1',content:'observed'}],has_more:false}}};
 f.worker.adapters.set('p',{version:f.consumer.version,execute:ctx=>f.consumer.execute({...ctx,discovery:{card:{note_id:id(1)}}})});
 f.worker.dispatch();await Promise.all(f.worker.active.values());assert.equal(f.store.request(f.request.id).state,'succeeded');assert.deepEqual(f.events,['card','comments','back','profile-confirmed','drain','close','drain']);
});

test('discovery comment drawer permits one additional verified Back',async t=>{
 const f=fixture(t,{...base,operation:'post.comments',targets:[{post_id:id(1)}]});let checks=0;
 f.consumer.navFactory=()=>({openDiscoveryCard:async()=>{},comments:async()=>{},back:async()=>f.events.push('back'),assertDiscoveryProfile:async()=>{if(++checks===1)throw Object.assign(Error(),{code:'PROFILE_RESTORE_UNCONFIRMED'});}});
 f.replies[0]={response:{data:{comments:[],has_more:false}}};f.worker.adapters.set('p',{version:f.consumer.version,execute:ctx=>f.consumer.execute({...ctx,discovery:{card:{note_id:id(1)}}})});
 f.worker.dispatch();await Promise.all(f.worker.active.values());assert.equal(f.store.request(f.request.id).state,'succeeded');assert.equal(checks,2);assert.equal(f.events.filter(e=>e==='back').length,2);
});

test('partial comment pagination retains observed rows and restores the profile before release',async t=>{
 const f=fixture(t,{...base,operation:'post.comments',targets:[{post_id:id(1)}],params:{max_items:20}});
 f.consumer.navFactory=()=>({openDiscoveryCard:async()=>{},comments:async()=>{},nextPage:async()=>{},back:async()=>f.events.push('back'),assertDiscoveryProfile:async()=>f.events.push('profile-confirmed')});
 f.replies.splice(0,1,{response:{data:{comments:[{id:'c1',content:'observed'}],cursor:'next',has_more:true}}},Object.assign(Error(),{code:'PHONE_PAGE_RESPONSE_UNOBSERVED'}));
 f.worker.adapters.set('p',{version:f.consumer.version,execute:ctx=>f.consumer.execute({...ctx,discovery:{card:{note_id:id(1)}}})});
 f.worker.dispatch();await Promise.all(f.worker.active.values());const rows=f.store.results(f.request.id).map(r=>r.payload);
 assert.equal(f.store.request(f.request.id).state,'succeeded');assert.equal(rows[0].data.raw.comments.list.length,1);
 assert.equal(rows.at(-1).data.stop_reason,'phone_page_response_unobserved');assert.equal(rows.at(-1).data.comments_complete,false);assert.equal(rows.at(-1).data.end_observed,false);
 assert.deepEqual(f.events.slice(0,2),['back','profile-confirmed']);assert.equal(f.store.devices()[0].owner,null);
});
test('an unobserved first comment page cannot become successful partial coverage',async t=>{
 const f=fixture(t,{...base,operation:'post.comments',targets:[{post_id:id(1)}],params:{max_items:20}});
 f.replies[0]=Object.assign(Error(),{code:'PHONE_PAGE_RESPONSE_UNOBSERVED'});f.worker.dispatch();await Promise.all(f.worker.active.values());
 assert.equal(f.store.results(f.request.id).length,0);assert.equal(f.store.request(f.request.id).units[0].error.code,'PHONE_PAGE_RESPONSE_UNOBSERVED');
});
test('combined comment pages count only projected comments while retaining survey evidence',async t=>{
 const f=fixture(t,{...base,operation:'post.comments',targets:[{post_id:id(1)}],params:{max_items:20}});
 const capture=(cid,more)=>({captured_at_ms:1000,operation:'comments',request:{query:[]},response:{data:{comments:[{id:cid,content:'observed'},{id:'survey-'+cid,show_type:'nps'}],has_more:more}},verified_identity:{non_comment_rows:[{path:['data','comments',1],kind:'nps_questionnaire'}]}});
 f.replies[0]={...capture('c1',true),related_pages:[capture('c2',false)]};
 f.worker.dispatch();await Promise.all(f.worker.active.values());const value=f.store.results(f.request.id)[0].payload;
 assert.equal(f.store.request(f.request.id).state,'succeeded');assert.deepEqual(value.data.raw.comments.list.map(c=>c.id),['c1','c2']);
 assert.equal(value.data.non_comment_count,2);assert.equal(value.data.native_evidence.length,2);assert.equal(value.data.end_observed,true);
 assert.equal(value.data.native_responses.reduce((total,r)=>total+r.response.data.comments.length,0),4);
});
