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
 const nav={search:async()=>events.push('search'),submitSearch:async()=>events.push('submit'),sort:async()=>events.push('sort'),confirmSortResponse:()=>{},swipe:async()=>events.push('swipe'),openProfile:async()=>events.push('profile'),refresh:async()=>events.push('refresh'),firstPage:async()=>events.push('refresh'),nextPage:async()=>events.push('swipe'),openNote:async()=>events.push('detail'),comments:async()=>{},back:async()=>events.push('back')};
 const replies=[{response:{data:{items:[{id:id(1),desc:'body',user:{userid:id(2)}}],has_more:false}}}];
 const consumer=new PhoneConsumer({store,gateway,deviceId:'p',contractPath:path.resolve(__dirname,'../contracts/xhs-app-9.51.0.json'),verifiedOperations:[input.operation],transportFactory:()=>({wait:async()=>{}}),runtimeFactory:()=>runtime,navFactory:()=>nav,capture:async options=>{captures.push(options);await options.guard();await options.trigger();const r=replies.shift();if(r instanceof Error)throw r;return {captured_at_ms:1000,status:200,operation:options.operation,request:{query:[]},effective_sort:'general',...r};}});
 const worker=new LocalWorker(store,new Map([['p',consumer]]),{heartbeatMs:5});t.after(async()=>{await worker.close();store.close();});const request=store.submit(input);return {store,worker,request,events,captures,replies,runtime,consumer};
}
test('phone consumer preserves the whole loaded page and captures only after UI input',async t=>{
 const f=fixture(t);f.replies[0].response.data.items.push({id:id(3),desc:'second'});f.worker.dispatch();await Promise.all(f.worker.active.values());
 assert.equal(f.store.request(f.request.id).state,'succeeded');const results=f.store.results(f.request.id);assert.equal(results[0].payload.data.raw.feeds.length,2);
 assert.deepEqual(f.events,['search','submit','sort','drain','close','drain']);assert.equal(f.captures[0].values.query.keyword,'词');assert.equal(f.captures[0].values.query.page_size,undefined);
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
 await Promise.all(f.worker.active.values());assert.equal(f.store.request(f.request.id).state,'succeeded');assert.equal(phase,'profile_note');assert.equal(f.store.results(f.request.id)[1].payload.data.raw.note.desc,'detail body');assert.ok(f.events.includes('back'));
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
