'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../service/store');
const {DiscoverySessions,normalize,card}=require('../service/discovery_sessions');
const id=n=>n.toString(16).padStart(24,'0'),user=id(999),day=86400000,base=Date.parse('2026-10-20T00:00:00Z');
const request={schema_version:'crawler.discovery.v1',platform:'xiaohongshu',user_id:user,mode:'count',count:20};
function setup(t,{missingDates=false,failDetail=false,total=40,kind='web'}={}){
 const store=new Store();store.register({id:'web:xhs:default',kind,serial:kind==='android'?'fixture':undefined,capabilities:['profile.posts','post.detail'].map(operation=>({platform:'xiaohongshu',operation}))});
 const calls=[],adapter={close:async()=>{calls.push('close');},execute:async ctx=>{
  const {operation,params,target}=ctx.claim.payload.operation?{...ctx.claim.payload,target:ctx.claim.target}:{};calls.push({operation,target,params});
  if(operation==='post.detail'){
   if(failDetail)throw Object.assign(Error(),{code:'DETAIL_FAILED'});
   const n=parseInt(target.post_id,16);ctx.commit({items:[{value:{phase:'result',data:{raw:{note:{noteId:target.post_id,user:{userId:user},time:base-n*day,desc:'real body'}}}}}]});return;
  }
  const feeds=Array.from({length:Math.min(total,Math.ceil(params.max_items/10)*10)},(_,i)=>({id:id(i+1),noteCard:{displayTitle:'post '+(i+1),time:missingDates?undefined:base-(i+1)*day,interactInfo:{sticky:false},cover:{urlDefault:'https://example.test/'+i+'.jpg'}}}));
  ctx.commit({items:[{value:{phase:'result',data:{raw:{feeds},end_observed:feeds.length===total,stop_reason:'target_loaded'}}}]});
 }};
 const sessions=new DiscoverySessions({store,adapters:new Map([['web:xhs:default',adapter]])});
 t.after(async()=>{await sessions.close();store.close();});return {store,sessions,calls};
}
test('count and dates are mutually exclusive, dates require timezone',()=>{
 assert.throws(()=>normalize({...request,startdate:'2026-10-01'},base),{code:'INVALID_DISCOVERY_MODE'});
 assert.throws(()=>normalize({...request,mode:'date',count:undefined,startdate:'2026-10-01'},base),{code:'INVALID_DISCOVERY_DATE'});
 assert.equal(normalize({schema_version:request.schema_version,platform:request.platform,user_id:user,mode:'date',startdate:'2026-10-01T00:00:00Z'},base).end,base);
});
test('first round keeps lease, no detail reads; empty second round releases; repeated completion idempotent',async t=>{
 const {store,sessions,calls}=setup(t);const result=await sessions.open({...request,count:21});
 assert.equal(result.cards.length,30);assert.equal(result.cards[0].body,null);assert.equal(result.coverage.complete,true);assert.ok(store.devices()[0].owner);assert.equal(calls.filter(c=>c.operation==='post.detail').length,0);
 const done=await sessions.complete(result.session_id,{selected_ids:[]});assert.equal(done.released,true);assert.equal(store.devices()[0].owner,null);assert.deepEqual(await sessions.complete(result.session_id,{selected_ids:[]}),done);
});
test('cleanup completion cannot mask a failed detail capture as session busy',async t=>{
 const {store,sessions}=setup(t,{failDetail:true});const r=await sessions.open(request);
 await assert.rejects(sessions.complete(r.session_id,{selected_ids:[id(1)]}),{code:'DETAIL_FAILED'});
 const failure=store.events(null).find(e=>e.type==='discovery.failed');
 assert.equal(failure.payload.operation,'post.detail');assert.equal(failure.payload.code,'DETAIL_FAILED');assert.equal(failure.payload.selected_index,0);
 assert.equal(store.devices()[0].owner,null);
 await assert.rejects(sessions.complete(r.session_id,{selected_ids:[]}),{code:'DETAIL_FAILED'});
 assert.equal((await sessions.cancel(r.session_id)).released,true);
});
test('only returned IDs, at most ten; details share same fenced lease and request share capture',async t=>{
 const {sessions,store,calls}=setup(t);const r=await sessions.open(request);
 await assert.rejects(sessions.complete(r.session_id,{selected_ids:[id(30)]}),{code:'INVALID_DISCOVERY_SELECTION'});
 await assert.rejects(sessions.complete(r.session_id,{selected_ids:Array.from({length:11},(_,i)=>id(i+1))}),{code:'INVALID_DISCOVERY_SELECTION'});
 const done=await sessions.complete(r.session_id,{selected_ids:[id(1)]});assert.equal(store.rawEvidence.readJson(done.details[0].data.raw_ref).note.desc,'real body');assert.equal(store.devices()[0].owner,null);assert.equal(calls.find(c=>c.operation==='post.detail').params.native_request.capture_share,true);
});
test('date boundary probes use cached ordered indices and return only inclusive range',async t=>{
 const {sessions,calls}=setup(t,{missingDates:true});const r=await sessions.open({schema_version:request.schema_version,platform:request.platform,user_id:user,mode:'date',startdate:new Date(base-8*day).toISOString(),enddate:new Date(base-3*day).toISOString()});
 assert.deepEqual(r.cards.map(c=>c.note_id),[3,4,5,6,7,8].map(id));assert.equal(r.coverage.complete,true);
 const probes=calls.filter(c=>c.operation==='post.detail').map(c=>c.target.post_id);assert.equal(new Set(probes).size,probes.length);assert.ok(probes.length<20);assert.ok(r.cards.every(c=>c.body===null));await sessions.complete(r.session_id,{selected_ids:[]});
});
test('detail failure drains and releases instead of retaining an orphan reservation',async t=>{
 const {sessions,store}=setup(t,{failDetail:true});const r=await sessions.open(request);
 await assert.rejects(sessions.complete(r.session_id,{selected_ids:[id(1)]}),{code:'DETAIL_FAILED'});assert.equal(store.devices()[0].owner,null);
});
test('list excerpt remains observed list text with explicit source, not full detail evidence',()=>{
 const c=card({id:id(1),noteCard:{desc:'a list excerpt',displayTitle:'t',cover:{url:'u'},interactInfo:{sticky:false}}},0);assert.equal(c.body,'a list excerpt');assert.equal(c.body_observed,true);assert.equal(c.body_source,'profile_excerpt');
});
test('HTTP round trip holds the device between requests and releases empty selection',async t=>{
 const {store,sessions}=setup(t),{createServer}=require('../service/server');const token='x'.repeat(40);
 const server=createServer({store,token,scheduler:{worker:{adapters:sessions.adapters}}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await server.drainDesktop();await new Promise(resolve=>server.close(resolve));});
 const post=async(path,value)=>{const response=await fetch('http://127.0.0.1:'+server.address().port+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(value)});return [response.status,await response.json()];};
 const [status,first]=await post('/v1/discovery-sessions',request);assert.equal(status,201);assert.ok(store.devices()[0].owner);
 const [doneStatus,done]=await post('/v1/discovery-sessions/'+first.session_id+'/complete',{selected_ids:[]});assert.equal(doneStatus,200);assert.equal(done.released,true);assert.equal(store.devices()[0].owner,null);
});
test('date mode does not confuse stagnant loading with observed end',async t=>{
 const {sessions,store}=setup(t);sessions.adapters.get('web:xhs:default').execute=async ctx=>ctx.commit({items:[{value:{phase:'result',data:{raw:ctx.claim.payload.operation==='post.detail'?{note:{noteId:id(1),time:base}}:{feeds:[{id:id(1),noteCard:{time:base,interactInfo:{sticky:false}}}]},stop_reason:'no_growth',end_observed:false}}}]});
 await assert.rejects(sessions.open({schema_version:request.schema_version,platform:request.platform,user_id:user,mode:'date',startdate:new Date(base-day).toISOString()}),{code:'DISCOVERY_DATE_COVERAGE_INCOMPLETE'});assert.equal(store.devices()[0].owner,null);
});
test('first-round disconnect aborts work and releases only after adapter drains',async t=>{
 const {sessions,store}=setup(t),controller=new AbortController();let drained=false;
 sessions.adapters.get('web:xhs:default').execute=async ctx=>new Promise((resolve,reject)=>ctx.signal.addEventListener('abort',()=>{drained=true;reject(ctx.signal.reason);},{once:true}));
 const pending=sessions.open(request,'pipeline',controller.signal);controller.abort();await assert.rejects(pending,{code:'CLIENT_DISCONNECTED'});assert.equal(drained,true);assert.equal(store.devices()[0].owner,null);
});
test('service heartbeat retains the idle reservation beyond the underlying lease TTL',async t=>{
 const {sessions,store}=setup(t);store.leaseMs=100;sessions.heartbeatMs=10;const r=await sessions.open(request);
 await new Promise(resolve=>setTimeout(resolve,160));assert.doesNotThrow(()=>store.assertLease(sessions.get(r.session_id,'pipeline').lease));
 await sessions.complete(r.session_id,{selected_ids:[]});assert.equal(store.devices()[0].owner,null);
});
test('later page evidence enriches initially missing pin state without replacing card identity/order',async t=>{
 const {sessions}=setup(t);sessions.adapters.get('web:xhs:default').execute=async ctx=>{
  if(ctx.claim.payload.operation==='post.detail'){ctx.commit({items:[{value:{phase:'result',data:{raw:{note:{noteId:id(1),time:base}}}}}]});return;}
  const row={id:id(1),noteCard:{displayTitle:'observed',time:base}};
  ctx.commit({items:[{value:{phase:'page',data:{raw:{feeds:[row],dom_cards:[]}}}}]});
  ctx.commit({items:[{value:{phase:'result',data:{raw:{feeds:[row],dom_cards:[{href:'/explore/'+id(1),sticky:false}]},end_observed:true}}}]});
 };
 const r=await sessions.open({schema_version:request.schema_version,platform:request.platform,user_id:user,mode:'date',startdate:new Date(base-day).toISOString()});assert.equal(r.cards[0].is_pinned,false);assert.equal(r.cards[0].index,0);await sessions.complete(r.session_id,{selected_ids:[]});
});
test('actual adapter field aliases preserve primary images and explicit numeric pinned evidence',()=>{
 const native=card({id:id(1),noteCard:{time:base/1000,interactInfo:{sticky:0},imageList:[{info_list:[{url:'https://example.test/original.jpg'}]}]}},0);
 assert.equal(native.cover_url,'https://example.test/original.jpg');assert.equal(native.is_pinned,false);assert.equal(native.published_at,new Date(base).toISOString());
 const web=card({noteId:id(2),noteCard:{displayTitle:'web',cover:{urlDefault:'https://example.test/cover.jpg'},interactInfo:{sticky:true}}},1);assert.equal(web.cover_url,'https://example.test/cover.jpg');assert.equal(web.is_pinned,true);
 assert.equal(card({id:id(3),noteCard:{}},2).is_pinned,null);
});
test('cancel during second round drains before release and cannot start the next selected note',async t=>{
 const {sessions,store}=setup(t);const r=await sessions.open(request);let started=0,drained=false;
 sessions.adapters.get('web:xhs:default').execute=async ctx=>{started++;await new Promise((resolve,reject)=>ctx.signal.addEventListener('abort',()=>{drained=true;reject(ctx.signal.reason);},{once:true}));};
 const completion=sessions.complete(r.session_id,{selected_ids:[id(1),id(2)]});const rejected=assert.rejects(completion,{code:'STOP_REQUESTED'});
 const cancelled=await sessions.cancel(r.session_id);await rejected;assert.equal(cancelled.released,true);assert.equal(drained,true);assert.equal(started,1);assert.equal(store.devices()[0].owner,null);
});
test('observed profile payload dates are preserved without deriving a date from the note ID',async t=>{
 const {sessions,calls}=setup(t);const first=await sessions.open(request);assert.equal(first.cards[0].published_at,new Date(base-day).toISOString());assert.equal(first.cards[0].published_at_source,'profile_payload');await sessions.complete(first.session_id,{selected_ids:[]});
 const dates=await sessions.open({schema_version:request.schema_version,platform:request.platform,user_id:user,mode:'date',startdate:new Date(base-8*day).toISOString(),enddate:new Date(base-3*day).toISOString()});assert.equal(calls.filter(c=>c.operation==='post.detail').length,0);assert.deepEqual(dates.cards.map(c=>c.note_id),[3,4,5,6,7,8].map(id));await sessions.complete(dates.session_id,{selected_ids:[]});
 const missing=card({id:'6ae8141a000000002503afb8',noteCard:{}},0);assert.equal(missing.published_at,null);
});
test('date expansion replays increasing profile targets and retains previously observed cards',async t=>{
 const {sessions,calls}=setup(t,{missingDates:true,total:60});const r=await sessions.open({schema_version:request.schema_version,platform:request.platform,user_id:user,mode:'date',startdate:new Date(base-32*day).toISOString(),enddate:new Date(base-27*day).toISOString()});
 assert.deepEqual(calls.filter(c=>c.operation==='profile.posts').map(c=>c.params.max_items),[20,40]);assert.deepEqual(r.cards.map(c=>c.note_id),[27,28,29,30,31,32].map(id));assert.equal(r.coverage.loaded_count,40);await sessions.complete(r.session_id,{selected_ids:[]});
});
test('native default empty desc is not evidence, while real original excerpt is retained',()=>{
 const absent=card({id:id(1),noteCard:{desc:'',_native_original:{id:id(1)}}},0);assert.equal(absent.body,null);assert.equal(absent.body_observed,false);
 const actual=card({id:id(2),noteCard:{desc:'normalized',_native_original:{id:id(2),description:'actual list text'}}},1);assert.equal(actual.body,'actual list text');assert.equal(actual.body_source,'profile_excerpt');
});
test('Android card discovery omits the unused legacy profile-header request',async t=>{
 const {sessions,calls}=setup(t,{kind:'android'});
 const r=await sessions.open(request);assert.equal(calls[0].params.native_request.kind,undefined);await sessions.complete(r.session_id,{selected_ids:[]});
});

test('discovery shares phone-first dispatch and honors explicit Web routing',async t=>{
 const {store,sessions}=setup(t);
 store.register({id:'z-phone',kind:'android',serial:'z-phone',capabilities:['profile.posts','post.detail'].map(operation=>({platform:'xiaohongshu',operation}))});
 sessions.adapters.set('z-phone',sessions.adapters.get('web:xhs:default'));
 const first=await sessions.open(request);assert.equal(first.device_id,'z-phone');
 await sessions.complete(first.session_id,{selected_ids:[]});
 const lease=store.externalLease('z-phone','operator');
 const busy=await sessions.open(request);assert.equal(busy.device_id,'web:xhs:default');
 await sessions.complete(busy.session_id,{selected_ids:[]});store.releaseExternal(lease);
 const explicit=await sessions.open({...request,routing:{kinds:['web']}});assert.equal(explicit.device_id,'web:xhs:default');
 await sessions.complete(explicit.session_id,{selected_ids:[]});
});

test('count exclusion replenishes quota without detail reads and exposes observed likes',async t=>{
 const {sessions,calls}=setup(t,{total:60});const adapter=sessions.adapters.get('web:xhs:default'),execute=adapter.execute;
 adapter.execute=ctx=>execute({...ctx,commit:page=>{for(const item of page.items||[])for(const row of item.value.data.raw.feeds||[]){row.noteCard.interactInfo.sticky=parseInt(row.id,16)<=3;row.noteCard.interactInfo.likedCount='12';}ctx.commit(page);}});
 const r=await sessions.open({...request,count:40,exclude_pinned:true});assert.deepEqual(calls.map(c=>c.params.max_items),[40,60]);assert.equal(r.cards.length,57);assert.ok(r.cards.every(c=>c.is_pinned===false&&c.like_count===12));assert.equal(r.coverage.excluded_pinned_count,3);assert.equal(r.coverage.target_met,true);await sessions.complete(r.session_id,{selected_ids:[]});
});
test('genuine short profile differs from an incomplete count walk',async t=>{
 const {sessions}=setup(t,{total:8});const short=await sessions.open({...request,exclude_pinned:true});assert.equal(short.coverage.end_observed,true);assert.equal(short.coverage.target_met,false);assert.equal(short.coverage.stop_reason,'profile_end');await sessions.complete(short.session_id,{selected_ids:[]});
 const adapter=sessions.adapters.get('web:xhs:default'),execute=adapter.execute;adapter.execute=ctx=>execute({...ctx,commit:page=>{for(const i of page.items){i.value.data.end_observed=false;i.value.data.stop_reason='no_growth';}ctx.commit(page);}});
 const incomplete=await sessions.open({...request,exclude_pinned:true});assert.equal(incomplete.coverage.end_observed,false);assert.equal(incomplete.coverage.target_met,false);assert.equal(incomplete.coverage.stop_reason,'no_growth');await sessions.complete(incomplete.session_id,{selected_ids:[]});
});
test('excluded count refuses unknown pin evidence and unknown likes stay null',async t=>{
 const {sessions,store}=setup(t);const adapter=sessions.adapters.get('web:xhs:default'),execute=adapter.execute;adapter.execute=ctx=>execute({...ctx,commit:page=>{for(const i of page.items)for(const row of i.value.data.raw.feeds)delete row.noteCard.interactInfo.sticky;ctx.commit(page);}});
 await assert.rejects(sessions.open({...request,exclude_pinned:true}),{code:'DISCOVERY_PIN_STATE_UNOBSERVED'});assert.equal(store.devices()[0].owner,null);
 for(const value of [undefined,null,'',true,'bad','1万',[],{},'1e2'])assert.equal(card({id:id(1),noteCard:{interactInfo:{likedCount:value}}},0).like_count,null);
 assert.equal(card({id:id(1),noteCard:{interactInfo:{likedCount:0}}},0).like_count,0);
});
test('ten selected notes forward bounded Web comment options and completion options are idempotent',async t=>{
 const {sessions,calls}=setup(t),r=await sessions.open(request),selection={selected_ids:Array.from({length:10},(_,i)=>id(i+1)),comments:true,comment_target:20,comment_seconds:300,comment_mode:'limited_lazy_load_on_scroll',comment_lazy_load_limit:2};
 const result=await sessions.complete(r.session_id,selection);assert.equal(result.details.length,10);for(const call of calls.filter(c=>c.operation==='post.detail')){assert.equal(call.params.native_request.comments,true);assert.equal(call.params.native_request.target,20);assert.equal(call.params.native_request.seconds,300);assert.equal(call.params.native_request.comment_lazy_load_limit,2);}
 assert.deepEqual(await sessions.complete(r.session_id,selection),result);await assert.rejects(sessions.complete(r.session_id,{...selection,comments:false}),{code:'DISCOVERY_SELECTION_CONFLICT'});
});
test('unavailable phone comment capability leaves session available for empty completion',async t=>{
 const {sessions}=setup(t,{kind:'android'}),r=await sessions.open(request);await assert.rejects(sessions.complete(r.session_id,{selected_ids:[id(1)],comments:true}),{code:'UNSUPPORTED_OPERATION'});assert.equal((await sessions.complete(r.session_id,{selected_ids:[]})).released,true);
});

test('phone comments keep capped coverage incomplete and preserve page evidence',async t=>{
 const {sessions,store}=setup(t,{kind:'android'});store.register({id:'web:xhs:default',kind:'android',serial:'fixture',capabilities:['profile.posts','post.detail','post.comments'].map(operation=>({platform:'xiaohongshu',operation}))});
 const adapter=sessions.adapters.get('web:xhs:default'),execute=adapter.execute;adapter.execute=ctx=>ctx.claim.payload.operation==='post.comments'?ctx.commit({items:[{value:{phase:'result',data:{raw:{comments:{list:[{id:'one',content:'real'}]}},end_observed:false,stop_reason:'native_page_limit',native_evidence:[{operation:'comments'}]}}}]}):execute(ctx);
 const r=await sessions.open(request),done=await sessions.complete(r.session_id,{selected_ids:[id(1)],comments:true});assert.equal(store.rawEvidence.readJson(done.details[0].data.comment_evidence[0].raw_ref).comments.list[0].content,'real');assert.equal(done.details[0].data.comments_complete,false);assert.equal(done.details[0].data.stop_reason,'native_page_limit');assert.equal(done.details[0].data.end_observed,false);assert.equal(done.details[0].data.comment_evidence.length,1);
});
