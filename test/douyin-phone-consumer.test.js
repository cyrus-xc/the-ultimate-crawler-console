'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DouyinPhoneAdapter}=require('../adapters/douyin-phone/consumer');
test('Douyin POI migrated harvester routes every input through current queue lease and commits candidate provenance',async()=>{
 const commands=[],pages=[];let guards=0;
 const lease={device_id:'android:a',token:'opaque',generation:1};
 const gateway={execute:async(l,c)=>{assert.deepEqual(l,lease);commands.push(c);return {stdout:'ok'};}};
 const store={devices:()=>[{id:'android:a',serial:'phone-a',clipboard_port:38700}]};
 const adapter=new DouyinPhoneAdapter({gateway,store,harvestImpl:async(adb,o)=>{
  assert.equal(adb.clipboardPort,38700);assert.deepEqual(o.knownIds,['123456789012346','old']);
  await adb.shell('input','tap','1','2');
  o.emit({event:'sheet',store:'Fixture Store'});
  o.emit({event:'post',video_id:'123456789012345',link:'https://www.douyin.com/video/123456789012345',title:'Visible caption'});
  o.emit({event:'done',reason:'MAX_POSTS'});
 }});
 const ctx={claim:{device_id:'android:a',lease,payload:{operation:'place.posts',params:{locator:{names:['Fixture Store'],known_ids:['123456789012346']},max_items:2}}},resume:{seen_ids:['old'],binding:'b'},signal:new AbortController().signal,
  guard(){guards++;},async input(fn){this.guard();return fn();},commit(p){pages.push(p);}};
 await adapter.execute(ctx);
 assert.equal(commands.length,1);assert.equal(commands[0].serial,'phone-a');assert.ok(guards>=4);
 assert.equal(pages[0].items[0].value.data.evidence_kind,'location_candidate_ui');
 assert.deepEqual(pages[0].checkpoint.seen_ids,['123456789012346','old','123456789012345']);assert.equal(pages[1].items[0].value.phase,'completion');
});
test('Douyin POI rejects invalid locator before touching gateway',async()=>{
 let calls=0;const adapter=new DouyinPhoneAdapter({gateway:{execute(){calls++;}},store:{devices:()=>[]}});
 await assert.rejects(adapter.execute({claim:{payload:{operation:'place.posts',params:{locator:{names:[]}}}}}),/INVALID_PLACE_LOCATOR/);assert.equal(calls,0);
});

test('place resume ids accept only bounded Douyin identities',()=>{const {normalize}=require('../service/contract');const p={schema_version:'crawler.request.v1',idempotency_key:'fixture',platform:'douyin',operation:'place.posts',targets:[{place_id:'fixture'}],params:{locator:{names:['fixture'],known_ids:['123456789012346']}}};assert.deepEqual(normalize(p).params.locator.known_ids,['123456789012346']);for(const ids of [['foreign'],[123456789012346],Array(10001).fill('123456789012346')])assert.throws(()=>normalize({...p,params:{locator:{names:['fixture'],known_ids:ids}}}),{code:'INVALID_PARAMS'});});
