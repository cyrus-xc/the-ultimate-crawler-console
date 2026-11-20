'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {Store}=require('../service/store');
const {PhoneWarmup,localDay,OWNER}=require('../service/phone_warmup');
const {browseFeed}=require('../adapters/xhs-phone/warmup');

const HOUR=3600000;
const phone='android:test-phone';
const request={schema_version:'crawler.request.v1',idempotency_key:'collection',platform:'xiaohongshu',
 operation:'search.posts',targets:[{keyword:'fixture'}],params:{max_items:1}};
function fixture(t,overrides={},leaseMs=30000){
 let now=Date.parse('2026-11-20T05:00:00Z');
 const store=new Store(':memory:',{now:()=>now,leaseMs});
 store.register({id:phone,kind:'android',serial:'test-phone',capabilities:[{platform:'xiaohongshu',operation:'search.posts'}]});
 store.register({id:'web:xhs:default',kind:'web',capabilities:[{platform:'xiaohongshu',operation:'search.posts'}]});
 const warmup=new PhoneWarmup(store,{retire:async()=>{},forgetReleased:()=>{}},{random:()=>.5,activeNow:()=>now,
  browse:({signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})),...overrides});
 t.after(async()=>{await warmup.close();store.close();});
 return {store,warmup,advance:ms=>{now+=ms;}};
}

test('only registered XHS phones receive a durable randomized daily schedule',t=>{
 const {store,warmup,advance}=fixture(t);
 warmup.tick();
 const device=store.devices().find(d=>d.id===phone);
 const first=warmup.view(device), start=Date.parse('2026-11-20T08:30:00Z');
 assert.equal(first.state,'scheduled');
 assert.equal(first.starts_at,start);
 assert.equal(first.target_ms,3.5*HOUR);
 assert.equal(first.stops_at,localDay(store.now())+24.5*HOUR);
 assert.equal(warmup.view(store.devices().find(d=>d.kind==='web')),null);
 assert.throws(()=>warmup.change('web:xhs:default',true),{code:'WARMUP_PHONE_REQUIRED'});
 advance(3.5*HOUR);
 warmup.tick();
 assert.equal(warmup.view(device).state,'running');
 assert.equal(store.devices().find(d=>d.id===phone).owner,OWNER);
 assert.equal(warmup.change(phone,true).starts_at,start);
});

test('queued collection interrupts a phone, retains active dwell, and resumes after release',async t=>{
 let entered;
 const {store,warmup,advance}=fixture(t,{
  wait:(_,value,{signal})=>new Promise((resolve,reject)=>{
   entered=resolve;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  }),
  browse:({dwell})=>dwell(5000),
 });
 warmup.change(phone,true);
 warmup.tick();
 assert.equal(typeof entered,'function');
 advance(750);
 store.submit(request);
 const active=warmup.active.get(phone);
 warmup.tick();
 await active.done;
 assert.equal(warmup.latest(phone).state,'paused');
 assert.equal(warmup.latest(phone).elapsed_ms,750);
 warmup.tick();
 assert.equal(warmup.active.has(phone),false);
 const collection=store.claim([phone]);
 assert.equal(collection.device_id,phone);
 store.commit(collection,{done:true});
 advance(7000);
 warmup.tick();
 assert.equal(warmup.latest(phone).state,'running');
 assert.equal(warmup.latest(phone).elapsed_ms,750);
});

test('a busy phone starts late, then expires at its cutoff without using paused time',async t=>{
 const {store,warmup,advance}=fixture(t,{},24*HOUR);
 const day=localDay(store.now());
 const lease=store.externalLease(phone,'manual-control');
 advance(4*HOUR);
 warmup.tick();
 assert.equal(warmup.latest(phone).state,'queued');
 advance(7*HOUR);
 warmup.tick();
 advance(.5*HOUR);
 warmup.tick();
 const expired=store.db.prepare('SELECT * FROM phone_warmup WHERE device_id=? AND day=?').get(phone,day);
 assert.equal(expired.state,'expired');
 assert.equal(expired.elapsed_ms,0);
 assert.equal(warmup.latest(phone).state,'scheduled');
 assert.equal(store.assertLease(lease).owner,'manual-control');
});

const XHS='com.xingin.xhs';
const n=(text,extra={})=>({text,package:XHS,center:[200,350],width:400,height:700,...extra});
const home=kind=>[n('首页'),n('发现'),n(kind+',样本,来自作者,12赞',{clickable:'true'})];
const post=()=>[n('',{'resource-id':XHS+':id/moreOperateIV'}),n('',{class:'android.widget.ImageView',center:[200,230],width:390,height:360}),n('点赞')];
function browser(views,randomValues){
 const actions=[],stopped=Error('end of fixture');
 const adb={
  ui:async()=>{if(!views.length)throw stopped;return views.shift();},
  wait:async()=>{},tap:async node=>actions.push(['tap',node.text]),
  shell:async(...args)=>actions.push(args),
 };
 const browse=()=>browseFeed(adb,{guard:()=>{},random:()=>randomValues.shift()??.5,dwell:async ms=>actions.push(['dwell',ms])});
 return {actions,stopped,browse};
}
test('photo browse swipes image, reads observed comments, then can double tap and return home',async()=>{
 const comments=[n('全部评论')], entry=[...post(),n('共 10 条评论',{clickable:'true'})];
 const f=browser([home('图文'),home('图文'),post(),post(),entry,comments,post(),post(),home('图文')],[0,.5,.01,.5,.01]);
 await assert.rejects(f.browse(),error=>error===f.stopped);
 assert.deepEqual(f.actions.filter(a=>a[0]==='dwell'),[['dwell',4000],['dwell',17500]]);
 assert.equal(f.actions.filter(a=>a[0]==='tap'&&a[1]==='').length,2);
 assert.equal(f.actions.filter(a=>a[0]==='input'&&a[1]==='keyevent').length,2);
 assert.ok(f.actions.some(a=>a[1]==='swipe'&&a[3]===a[5]&&a[2]>a[4]));
});

test('video browse uses the visible like button and advances upward',async()=>{
 const video=['matrixAvatarView','matrixNickNameView','noteContentText']
  .map(id=>n('',{'resource-id':XHS+':id/'+id})).concat(
   n('',{clickable:'true',center:[100,630],width:90,height:40,class:'android.widget.LinearLayout'}),
   n('Collect12',{clickable:'true',center:[200,630],width:100,height:40,class:'android.widget.Button'}),
   n('Comment 5',{clickable:'true',center:[300,630],width:100,height:40,class:'android.widget.Button'}),
  );
 const feed=[n('首页'),n('发现'),n('视频 样本，来自作者，12赞',{clickable:'false',class:'android.widget.FrameLayout'}),
  n('卡片容器',{clickable:'true',class:'android.widget.FrameLayout'})];
 const f=browser([feed,feed,video,video],[0,.5,.01]);
 await assert.rejects(f.browse(),error=>error===f.stopped);
 assert.ok(f.actions.some(a=>a[0]==='tap'&&a[1]==='卡片容器'));
 assert.ok(f.actions.some(a=>a[0]==='dwell'&&a[1]===9000));
 assert.ok(f.actions.some(a=>a[0]==='tap'&&a[1]===''));
 assert.ok(f.actions.some(a=>a[1]==='swipe'&&a[3]>a[5]));
});

test('a platform restriction stops browsing before any tap or swipe',async()=>{
 const f=browser([[n('检测到异常访问，本次访问已被限制')]],[]);
 await assert.rejects(f.browse(),{code:'XHS_ACCESS_RESTRICTED'});
 assert.equal(f.actions.length,1);
 assert.equal(f.actions[0][0],'monkey');
});

test('completion caps active time at the assigned target and preserves the next daily schedule',async t=>{
 const {store,warmup,advance}=fixture(t,{},5*HOUR);
 warmup.change(phone,true);warmup.tick();
 advance(3.5*HOUR+2000);
 const active=warmup.active.get(phone);
 warmup.tick();await active.done;
 assert.equal(warmup.latest(phone).state,'completed');
 assert.equal(warmup.latest(phone).elapsed_ms,3.5*HOUR);
 assert.equal(store.devices().find(d=>d.id===phone).owner,null);
 const day=localDay(store.now());
 advance(11*HOUR);warmup.tick();
 assert.equal(warmup.latest(phone).day,day+24*HOUR);
 assert.equal(warmup.latest(phone).state,'scheduled');
});

test('an external discovery handoff drains before a new lease and manual stop prevents resumption',async t=>{
 const {store,warmup,advance}=fixture(t);
 warmup.change(phone,true);warmup.tick();
 advance(2000);
 await warmup.yieldDevice(phone);
 const lease=store.externalLease(phone,'discovery:fixture');
 assert.equal(warmup.latest(phone).state,'paused');
 assert.equal(warmup.latest(phone).elapsed_ms,2000);
 warmup.change(phone,false);
 store.releaseExternal(lease);
 advance(2000);warmup.tick();
 assert.equal(warmup.latest(phone).state,'stopped');
 assert.equal(warmup.active.has(phone),false);
});
