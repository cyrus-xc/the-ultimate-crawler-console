'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {Store}=require('../service/store');
const {DeviceModes}=require('../service/device_modes');
const {PhoneWarmup}=require('../service/phone_warmup');
const {LocalWorker}=require('../service/worker');

const HOUR=3600000;
const phone='android:test-phone',web='web:xhs:default';
const request=(pipeline)=>({schema_version:'crawler.request.v1',idempotency_key:'k-'+Math.random(),platform:'xiaohongshu',
 operation:'profile.posts',targets:[{user_id:'5a8abefce8ac2b469601edea'}],params:{max_items:1},...(pipeline?{context:{pipeline}}:{})});
function fixture(t){
 let now=Date.parse('2026-11-20T05:00:00Z');
 const store=new Store(':memory:',{now:()=>now});
 store.register({id:phone,kind:'android',serial:'test-phone',capabilities:[{platform:'xiaohongshu',operation:'profile.posts'}]});
 store.register({id:web,kind:'web',capabilities:[{platform:'xiaohongshu',operation:'profile.posts'}]});
 store.modes=new DeviceModes(store);
 t.after(()=>store.close());
 return {store,modes:store.modes,advance:ms=>{now+=ms;}};
}

test('devices default to mixed and reject unknown modes, web nurture and bad hours',t=>{
 const {modes}=fixture(t);
 assert.deepEqual(modes.get(phone),{mode:'mixed',projects:[],topics:[],until:null});
 assert.throws(()=>modes.set(phone,{mode:'sleep'}),{code:'MODE_INVALID'});
 assert.throws(()=>modes.set(web,{mode:'nurture'}),{code:'MODE_UNSUPPORTED'});
 assert.throws(()=>modes.set(phone,{mode:'crawl',hours:-1}),{code:'MODE_HOURS_INVALID'});
 assert.throws(()=>modes.set('android:none',{mode:'crawl'}),{code:'DEVICE_NOT_FOUND'});
 assert.throws(()=>modes.set(phone,{mode:'crawl',projects:'kol'}),{code:'MODE_PROJECTS_INVALID'});
});

test('off and nurture devices receive no queue work; projects narrow what a device takes',t=>{
 const {store,modes}=fixture(t);
 const pending=[],hold={execute:()=>new Promise(resolve=>pending.push(resolve))};
 const worker=new LocalWorker(store,new Map([[phone,hold],[web,hold]]));
 t.after(async()=>{worker.closing=true;pending.forEach(resolve=>resolve({items:[]}));await Promise.allSettled([...worker.active.values()]);});
 modes.set(phone,{mode:'off'});modes.set(web,{mode:'crawl',projects:['kol-food']});
 store.submit(request('other'));
 assert.equal(worker.dispatch(),0);
 store.submit(request('kol-food'));
 assert.equal(worker.dispatch(),1);
 assert.equal(store.db.prepare("SELECT device_id FROM attempts").get().device_id,web);
 modes.set(phone,{mode:'nurture'});
 assert.equal(worker.dispatch(),0);
 modes.set(phone,{mode:'crawl'});
 assert.equal(worker.dispatch(),1);
 assert.equal(store.db.prepare("SELECT count(*) n FROM attempts WHERE device_id=?").get(phone).n,1);
});

test('a timed mode returns the device to mixed when it ends',t=>{
 const {modes,advance,store}=fixture(t);
 assert.equal(modes.set(phone,{mode:'off',hours:2}).until,store.now()+2*HOUR);
 advance(2*HOUR-1);
 assert.equal(modes.get(phone).mode,'off');
 advance(1);
 assert.equal(modes.get(phone).mode,'mixed');
 assert.ok(store.db.prepare("SELECT 1 FROM events WHERE type='device.mode_changed' AND json_extract(payload,'$.reason')='expired'").get());
});

test('warm-up follows the mode: crawl and off stop it, nurture runs it despite queued work',async t=>{
 const {store,modes,advance}=fixture(t);
 const warmup=new PhoneWarmup(store,{retire:async()=>{},forgetReleased:()=>{}},{random:()=>.5,activeNow:()=>store.now(),
  browse:({signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))});
 t.after(()=>warmup.close());
 modes.set(phone,{mode:'crawl'});
 warmup.change(phone,true);
 warmup.tick();
 assert.equal(warmup.active.has(phone),false);
 modes.set(phone,{mode:'nurture'});
 store.submit(request());
 warmup.tick();
 const task=warmup.active.get(phone);
 assert.ok(task,'nurture browses although collection is queued');
 modes.set(phone,{mode:'off'});
 warmup.tick();
 await task.done;
 assert.equal(warmup.latest(phone).state,'paused');
 warmup.tick();
 assert.equal(warmup.active.has(phone),false);
 // nurture also starts a day that has not reached its planned start
 modes.set(phone,{mode:'nurture'});
 advance(24*HOUR);
 warmup.tick();
 assert.ok(warmup.active.has(phone));
});
