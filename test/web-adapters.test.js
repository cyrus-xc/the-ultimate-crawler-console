'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {XhsWebAdapter,nativeRequest}=require('../adapters/xhs-web/adapter');const {DouyinWebAdapter}=require('../adapters/douyin-web/adapter');const {Store}=require('../service/store');const {registerWebAdapters}=require('../service/web_adapters');
function claim(operation='post.detail',params={}){return {device_id:'web:xhs:default',target:operation.startsWith('profile')?{user_id:'a'.repeat(24)}:operation==='search.posts'?{keyword:'测试'}:{post_id:'a'.repeat(24)},payload:{platform:'xiaohongshu',operation,params,limits:{max_pages:3,execution_timeout_seconds:60},cache:{mode:'refresh'}}};}
function context(c){const pages=[];return {claim:c,resume:{seen_ids:[],binding:'test',cursor:null},signal:new AbortController().signal,guard(){},input:async fn=>fn(),commit:p=>pages.push(p),waitForDecision:async()=> 'continue',pages};}
test('web registration uses exactly one isolated instance per platform and opt-in only',()=>{const s=new Store(':memory:');assert.equal(registerWebAdapters(s,{env:{}}).size,0);const a=registerWebAdapters(s,{env:{CRAWLER_XHS_WEB_ENABLED:'true',CRAWLER_DOUYIN_WEB_ENABLED:'true'}});assert.deepEqual([...a.keys()],['web:xhs:default','web:douyin:default']);assert.notEqual(a.values().next().value,[...a.values()][1]);s.close();});
test('native read mapping preserves explicit read controls and rejects cross-target or arbitrary arguments',()=>{const c=claim('post.comments',{native_request:{comments:true,target:25,seconds:45,comment_mode:'sample'}});assert.equal(nativeRequest(c).target,25);assert.equal(nativeRequest(c).comments,true);c.payload.params.native_request.id='b'.repeat(24);assert.throws(()=>nativeRequest(c),/TARGET_MISMATCH/);c.payload.params.native_request={command:'publish'};assert.throws(()=>nativeRequest(c),/INVALID_NATIVE_REQUEST/);});
test('observed access URL must match actual target and trusted platform host',()=>{const c=claim();c.target.observed_url='https://example.com/explore/'+c.target.post_id;assert.throws(()=>nativeRequest(c),/INVALID_OBSERVED_URL/);c.target.observed_url='https://www.xiaohongshu.com/explore/'+c.target.post_id+'?xsec_token=fixture';assert.equal(nativeRequest(c).xsec_token,'fixture');});
test('XHS transport retains raw result and forwards distinct capture-share decision',async t=>{
 let capture;let stream;
 const server=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;if(req.url==='/read'){stream=res;res.write(JSON.stringify({phase:'detail_ready',note_id:'a'.repeat(24),decision_id:'d',data:{raw:{note:{title:'原始'}}}})+'\n');}else{capture=JSON.parse(body).capture;res.end('{}');stream.end(JSON.stringify({success:true,data:{raw:{note:{title:'原始'}},comments:[]}})+'\n');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const adapter=new XhsWebAdapter();adapter.ensure=async()=>({port:server.address().port,token:'fixture'});const ctx=context(claim('post.detail',{native_request:{select_share:true}}));ctx.waitForDecision=async()=>ctx.pages.length===1?{action:'continue',capture_share:false}:'continue';await adapter.execute(ctx);assert.equal(capture,false);assert.equal(ctx.pages[0].checkpoint.decision.phase,'detail_ready');assert.equal(ctx.pages[1].items[0].value.data.raw.note.title,'原始');
});
test('cache-only does not start web runtime and unsupported filters fail before navigation',async()=>{const a=new XhsWebAdapter();a.ensure=()=>{throw Error('must not start');};const c=claim();c.payload.cache.mode='only';await assert.rejects(a.execute(context(c)),/CACHE_MISS/);c.payload.cache.mode='refresh';c.payload.params.filters={unsupported:true};await assert.rejects(a.execute(context(c)),/UNSUPPORTED_FILTER/);});
test('XHS stop decision drains session instead of allowing another browser action',async()=>{const {Readable}=require('node:stream');const a=new XhsWebAdapter();let closed=false;a.ensure=async()=>({});a.close=async()=>{closed=true;};a.request=async()=>Readable.from([JSON.stringify({phase:'profile_note',note_id:'a'.repeat(24),decision_id:'d',data:{note:{}}})+'\n']);const ctx=context(claim('profile.posts'));ctx.waitForDecision=async()=>({action:'stop'});await a.execute(ctx);assert.equal(closed,true);});
test('Douyin subprocess waits for input admission and preserves raw records across page decisions',async()=>{
 const {spawn}=require('node:child_process');const script=`const r=require('node:readline').createInterface({input:process.stdin});let n=0;r.on('line',l=>{n++;if(n===1)console.log(JSON.stringify({type:'input'}));if(n===2)console.log(JSON.stringify({type:'page',data:{body:{comments:[{cid:'c'}]},items:[{cid:'c'}],cursor:20,records:[{endpoint:'aweme_v1_web_comment_list',body:{comments:[{cid:'c'}]}}]}}));if(n===3)console.log(JSON.stringify({type:'done'}));});`;
 const adapter=new DouyinWebAdapter({env:process.env,spawnProcess:()=>spawn(process.execPath,['-e',script],{stdio:['pipe','pipe','ignore'],detached:true})});let admissions=0;const ctx=context(claim('post.comments'));ctx.input=async fn=>{admissions++;return fn();};try{await adapter.execute(ctx);assert.equal(admissions,1);assert.equal(ctx.pages[0].items[0].value.data.records[0].endpoint,'aweme_v1_web_comment_list');assert.equal(ctx.pages[0].checkpoint.cursor,20);}finally{await adapter.close();}
});
test('Douyin cancellation waits for child exit and rejects further work from that child',async()=>{
 const {spawn}=require('node:child_process');const adapter=new DouyinWebAdapter({env:process.env,spawnProcess:()=>spawn(process.execPath,['-e',`process.stdin.resume();setInterval(()=>{},1000)`],{stdio:['pipe','pipe','ignore'],detached:true})});const ctx=context(claim()),controller=new AbortController();ctx.signal=controller.signal;const run=adapter.execute(ctx);const child=adapter.session.child;controller.abort();await assert.rejects(run,/STOP_REQUESTED/);assert.notEqual(child.signalCode,null);assert.equal(adapter.session,null);
});
test('manual XHS resume validates the live session before reporting authenticated',async()=>{
 const {Readable}=require('node:stream');const a=new XhsWebAdapter();a.ensure=async()=>({});let route;a.request=async(_s,r)=>{route=r;return Readable.from(['{"success":false,"error":"LOGIN_REQUIRED"}']);};await assert.rejects(a.resume(),{code:'LOGIN_REQUIRED'});assert.equal(route,'/desktop/confirm');a.request=async()=>Readable.from(['{"success":true}']);assert.deepEqual(await a.resume(),{authenticated:true});
});
test('platform login refusal preserves the existing XHS window for human recovery',async()=>{
 const {Readable}=require('node:stream');const a=new XhsWebAdapter();a.ensure=async()=>({});let closed=false;a.close=async()=>{closed=true;};a.request=async()=>Readable.from(['{"success":false,"error":"CRAWLER_RELOGIN_REQUIRED"}\n']);await assert.rejects(a.execute(context(claim())),{code:'CRAWLER_RELOGIN_REQUIRED'});assert.equal(closed,false);
});
test('Douyin resume requests read-only login verification without navigating',async()=>{const a=new DouyinWebAdapter();let operation;a.execute=async ctx=>{operation=ctx.claim.payload.operation;};assert.deepEqual(await a.resume(),{authenticated:true});assert.equal(operation,'resume');});
test('concurrent release and lease-loss cleanup both wait for the same browser drain',async()=>{
 for(const Adapter of [XhsWebAdapter,DouyinWebAdapter]){
  const a=new Adapter();let resolve,calls=0,finished=0;a.closeOwned=async()=>{calls++;await new Promise(r=>{resolve=r;});};const first=a.close().then(()=>finished++),second=a.close().then(()=>finished++);await Promise.resolve();assert.equal(calls,1);assert.equal(finished,0);resolve();await Promise.all([first,second]);assert.equal(finished,2);
 }
});
test('expired desktop guard cannot start an XHS session or authorize a Douyin input',async()=>{
 for(const Adapter of [XhsWebAdapter,DouyinWebAdapter]){
  const a=new Adapter();a.ensure=()=>{throw Error('STARTED_RUNTIME');};await assert.rejects(a.desktop({guard:()=>{throw Error('LEASE_LOST');}}),/LEASE_LOST/);
 }
});
test('XHS resume tolerates page hydration but rechecks its lease before every poll',async()=>{
 const {Readable}=require('node:stream');const a=new XhsWebAdapter();a.ensure=async()=>({});let reads=0;
 a.request=async()=>Readable.from([JSON.stringify(++reads===1?{success:false,error:'LOGIN_REQUIRED'}:{success:true})]);
 assert.deepEqual(await a.resume(),{authenticated:true});assert.equal(reads,2);
 reads=0;let guards=0;await assert.rejects(a.resume({guard(){if(++guards===3)throw Object.assign(Error('LEASE_LOST'),{code:'LEASE_LOST'});}}),{code:'LEASE_LOST'});assert.equal(reads,1);
});

// A caller budget error must settle this request, not take a shared browser down.
test('INVALID_BUDGET is an item failure and leaves Web eligible for the next request',async t=>{
 const {Readable}=require('node:stream'),{LocalWorker}=require('../service/worker');
 const s=new Store(':memory:');t.after(()=>s.close());s.register({id:'web:xhs:default',kind:'web',capabilities:[{platform:'xiaohongshu',operation:'post.detail'}]});
 const adapter=new XhsWebAdapter();adapter.ensure=async()=>({});adapter.close=async()=>{};
 adapter.request=async()=>Readable.from([JSON.stringify({success:false,error:'INVALID_BUDGET'})+'\n']);
 const input={schema_version:'crawler.request.v1',idempotency_key:'invalid-budget',platform:'xiaohongshu',operation:'post.detail',targets:[{post_id:'a'.repeat(24)}],routing:{kinds:['web']},params:{native_request:{comments:true,target:201,seconds:300,comment_mode:'limited_lazy_load_on_scroll',comment_lazy_load_limit:2}}};
 const request=s.submit(input),worker=new LocalWorker(s,new Map([['web:xhs:default',adapter]]));worker.dispatch();await Promise.all(worker.active.values());
 assert.equal(s.request(request.id).state,'failed');assert.equal(s.request(request.id).units[0].error.scope,'item');
 assert.equal(s.devices()[0].health,'ready');assert.deepEqual(s.devices()[0].faults,{});assert.equal(s.devices()[0].owner,null);
 s.submit({...input,idempotency_key:'next-valid',params:{native_request:{comments:false,target:50,seconds:45}}});assert.ok(s.claim());
});
