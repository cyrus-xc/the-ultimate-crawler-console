'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {lookup}=require('../adapters/android-ui/venue_lookup');
test('venue lookup delegates search to shared semantic navigation under the assigned lease',async()=>{
 const calls=[];const tab={text:'地点',center:[20,40]};let guards=0,released=0;
 const adb={devices:async()=>[{serial:'one',state:'device'}],ui:async()=>[tab],tap:async n=>calls.push(['tap',n]),wait:async()=>{}};
 const result=await lookup({platform:'xiaohongshu',serial:'one',venue_name:'observed shop'},{
  adbFactory:()=>adb,worker:{clipboardPort:9418,acquire:async s=>calls.push(['lease',s]),release:async()=>released++},guard:()=>guards++,
  navigationFactory:(actual,options)=>({search:async query=>{assert.equal(actual,adb);assert.equal(options.clipboardPort,9418);await options.guard();calls.push(['search',query]);}})
 });
 assert.deepEqual(calls,[['lease','one'],['search','observed shop'],['tap',tab]]);assert.equal(guards,1);assert.equal(released,1);
 assert.equal(result.reason,'VENUE_NOT_FOUND');assert.equal(result.status,'needs_review');
});
test('failed semantic search never falls back to guessed venue input and releases ownership',async()=>{
 let released=0;
 await assert.rejects(lookup({platform:'xiaohongshu',serial:'one',venue_name:'shop'},{
  adbFactory:()=>({devices:async()=>[{serial:'one',state:'device'}],ui:async()=>{throw Error('must not continue');}}),
  worker:{acquire:async()=>{},release:async()=>released++},navigationFactory:()=>({search:async()=>{throw Object.assign(Error('UI_CONTROL_AMBIGUOUS'),{code:'UI_CONTROL_AMBIGUOUS'});}})
 }),/UI_CONTROL_AMBIGUOUS/);assert.equal(released,1);
});
