'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {AndroidUiAdapter}=require('../adapters/android-ui/consumer');
function context(operation='post.detail'){
 const commits=[];return {commits,claim:{payload:{platform:'xiaohongshu',operation,params:{native_request:{representation:'ui_identity'}}},target:{post_id:'n',keyword:'shop'},device_id:'d',lease:'lease'},resume:{binding:'b'},guard(){},input:fn=>fn(),commit:v=>commits.push(v),waitForDecision:async()=>{}};
}
test('UI identity carries only observed identity under scheduler serial and lease',async()=>{
 const ctx=context();const calls=[];
 const adapter=new AndroidUiAdapter({store:{devices:()=>[{id:'d',serial:'serial',clipboard_port:9418}]},gateway:{execute:async(...args)=>{calls.push(args);return {stdout:'ok'};}},recoverImpl:async(req,options)=>{
  await options.worker.acquire('serial');await options.worker.command('serial',['shell','true']);
  await assert.rejects(options.worker.command('other',[]),/DEVICE_IDENTITY_MISMATCH/);
  return {note_id:'n',author_uid:'author',identity_confirmed:true,verified_at:'2020-01-01T00:00:00Z'};
 }});await adapter.execute(ctx);
 assert.equal(calls[0][0],'lease');assert.equal(calls[0][1].serial,'serial');
 const value=ctx.commits[0].items[0].value;assert.equal(value.data.author_uid,'author');assert.equal(value.data.evidence_kind,'ui_identity');assert.equal(value.observed_at,'2020-01-01T00:00:00Z');assert.equal(value.data.body,undefined);
});
test('place lookup reuses existing UI helper with explicit assigned device',async()=>{
 const ctx=context('place.search');let request;
 await new AndroidUiAdapter({store:{devices:()=>[{id:'d',serial:'serial'}]},lookupImpl:async value=>{request=value;return {status:'observed',poi_id:'p'};}}).execute(ctx);
 assert.equal(request.serial,'serial');assert.equal(request.query,'shop');assert.equal(ctx.commits[0].items[0].value.data.poi_id,'p');
});

test('UI helper capabilities can be enabled independently per verified platform and operation',()=>{
 const {uiCapabilities}=require('../service/phone_adapters');
 assert.deepEqual(uiCapabilities({}),[]);
 assert.deepEqual(uiCapabilities({ui_capabilities:[{platform:'xiaohongshu',operation:'post.detail'}]}),[{platform:'xiaohongshu',operation:'post.detail',representations:['ui_identity']}]);
 assert.throws(()=>uiCapabilities({ui_capabilities:[{platform:'douyin',operation:'place.search'}]}),{code:'INVALID_PHONE_CAPABILITIES'});
});
test('XHS place harvest preserves streamed candidate events and checkpoint before later failure',async()=>{const ctx=context('place.posts');ctx.claim.payload.params={native_request:{kind:'location_page'},locator:{seed_post:'a'.repeat(24)},published_after:'2026-01-02T00:00:00Z',max_items:7};ctx.resume.seen_ids=['prior'];const adapter=new AndroidUiAdapter({store:{devices:()=>[{id:'d',serial:'serial'}]},harvestImpl:async(adb,o)=>{assert.equal(o.seed,'a'.repeat(24));assert.equal(o.since,'2026-01-02');assert.equal(o.max,7);o.emit({event:'store',name:'Shop'});o.emit({event:'note',note_id:'b'.repeat(24),link:'observed'});o.emit({event:'skip',reason:'NO_LINK',title:'Unresolved candidate'});throw Object.assign(Error('stop'),{code:'ACCOUNT_REQUIRED'});}});await assert.rejects(adapter.execute(ctx),{code:'ACCOUNT_REQUIRED'});assert.deepEqual(ctx.commits.map(p=>p.items[0].value.data.event),['store','note','skip']);assert.deepEqual(ctx.commits.at(-1).checkpoint.seen_ids,['prior','b'.repeat(24)]);});
