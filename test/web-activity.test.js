'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {Store}=require('../service/store');
const {Pacer,loadProfile}=require('../service/pacer');
const {DeviceModes}=require('../service/device_modes');
const {WebActivity}=require('../service/web_activity');

const MIN=60000,HOUR=60*MIN;
const web='web:xhs:default',uid='5a8abefce8ac2b469601edea';
function fixture(t,{fail=null}={}){
 let now=Date.parse('2026-11-20T06:00:00Z');
 const store=new Store(':memory:',{now:()=>now});
 store.register({id:web,kind:'web',capabilities:[{platform:'xiaohongshu',operation:'profile.posts'}]});
 store.modes=new DeviceModes(store);
 const pacer=new Pacer(store,loadProfile('human_v1'),{now:()=>now,random:()=>.5});
 const calls=[];
 const adapter={activity:async(route,body)=>{calls.push([route,body]);if(fail)throw Object.assign(Error(fail),{code:fail,scope:'platform'});
  now+=route==='/browse'?body.seconds*1000:30000;return route==='/follow'?{state:'followed'}:{scrolls:3,opened:1};}};
 const activity=new WebActivity(store,new Map([[web,adapter]]),{pacer,random:()=>.5});
 t.after(async()=>{await activity.close();store.close();});
 const breakNow=()=>store.db.prepare('INSERT OR REPLACE INTO device_pacing(device_id,day,count,burst_left,next_at,break_until) VALUES (?,?,?,?,?,?)')
  .run(web,0,0,20,0,now+5*MIN);
 return {store,pacer,activity,calls,breakNow,advance:ms=>{now+=ms;},now:()=>now};
}
const settle=async a=>{await Promise.allSettled([...a.running.values()].map(r=>r.task));};

test('web browsing runs only inside a pacing break and stops at the daily budget',async t=>{
 const f=fixture(t);
 f.activity.tick();
 assert.equal(f.calls.length,0,'no break, no browsing');
 f.breakNow();f.activity.tick();await settle(f.activity);
 assert.equal(f.calls[0][0],'/browse');
 assert.ok(f.calls[0][1].seconds>=30&&f.calls[0][1].seconds<=240);
 assert.equal(f.store.devices()[0].owner,null,'lease released');
 f.store.db.prepare('UPDATE web_browse SET ms=?').run(90*MIN);
 f.breakNow();f.activity.tick();await settle(f.activity);
 assert.equal(f.calls.length,1,'budget used up');
});

test('follows wait for approval or the notice window, are capped and never repeated; posts need approval',async t=>{
 const f=fixture(t);
 const a=f.activity.propose('follow',web,{user_id:uid,nickname:'x'});
 assert.equal(f.activity.propose('follow',web,{user_id:uid}).id,a.id,'no duplicate proposal');
 f.breakNow();f.activity.tick();await settle(f.activity);
 assert.equal(f.calls.at(-1)[0],'/browse','an undecided follow waits');
 f.advance(2*HOUR);f.breakNow();f.activity.tick();await settle(f.activity);
 assert.equal(f.calls.at(-1)[0],'/follow');
 assert.equal(f.activity.get(a.id).state,'done');
 const p=f.activity.propose('publish',web,{title:'t',content:'c',images:['/x/a.jpg']});
 f.advance(HOUR);f.breakNow();f.activity.tick();await settle(f.activity);
 assert.notEqual(f.calls.at(-1)[0],'/publish');
 f.activity.decide(p.id,true);
 assert.throws(()=>f.activity.decide(p.id,false),{code:'ACTIVITY_ALREADY_DECIDED'});
 f.breakNow();f.activity.tick();await settle(f.activity);
 assert.equal(f.calls.at(-1)[0],'/publish');
 const r=f.activity.propose('follow',web,{user_id:'5a8abefce8ac2b469601edeb'});
 f.activity.decide(r.id,false);f.advance(3*HOUR);f.breakNow();f.activity.tick();await settle(f.activity);
 assert.equal(f.activity.get(r.id).state,'rejected');
 assert.throws(()=>f.activity.propose('follow',web,{user_id:'bad'}),{code:'ACTIVITY_PAYLOAD_INVALID'});
});

test('an access signal brakes the web device and an account signal holds it',async t=>{
 const f=fixture(t,{fail:'CRAWLER_VERIFICATION_REQUIRED'});
 f.breakNow();f.activity.tick();await settle(f.activity);
 assert.equal(f.pacer.state(web).state,'brake');
 assert.equal(f.store.devices()[0].faults.xiaohongshu,'CRAWLER_VERIFICATION_REQUIRED');
 assert.equal(f.store.devices()[0].owner,null);
});

test('an off or crawl-only web device does no activity',async t=>{
 const f=fixture(t);
 f.store.modes.set(web,{mode:'crawl'});
 f.breakNow();f.activity.tick();await settle(f.activity);
 assert.equal(f.calls.length,0);
});
