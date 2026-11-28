'use strict';
// Pacing, gesture variety, dialog handling, input evidence and warm-up sessions.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../service/store');
const {Pacer,loadProfile,localDay}=require('../service/pacer');
const {XhsNavigation}=require('../adapters/xhs-phone/navigation');
const {createInputLog,describeInput}=require('../service/input_log');
const {PhoneWarmup}=require('../service/phone_warmup');

const MIN=60000,HOUR=60*MIN,DAY=24*HOUR;
const REDMI='android:7e9c701e',ONEPLUS='android:c7dee0b3';
const profile=loadProfile('human_v1');
function pacing(t,start){
 let now=start;const store=new Store(':memory:',{now:()=>now});
 store.register({id:REDMI,kind:'android',serial:'7e9c701e'});store.register({id:ONEPLUS,kind:'android',serial:'c7dee0b3'});
 store.register({id:'web:xhs:default',kind:'web'});
 t.after(()=>store.close());
 const pacer=new Pacer(store,profile,{now:()=>now});
 return {store,pacer,at:value=>{now=value;},now:()=>now};
}
// 14:00 local on an ordinary day: both phones awake.
const afternoon=localDay(Date.UTC(2026,10,27,6))+14*HOUR;

test('gaps between items vary within the profile bounds and a device waits for its gap',t=>{
 const f=pacing(t,afternoon),gaps=[];
 f.pacer.state(REDMI);f.at(afternoon+60000);
 for(let i=0;i<200;i++){
  assert.equal(f.pacer.ready(REDMI),true);
  f.pacer.started(REDMI);f.pacer.finished(REDMI);
  assert.equal(f.pacer.ready(REDMI),false);
  const st=f.pacer.state(REDMI);gaps.push(st.until-f.now());f.at(st.until);
  if(f.pacer.state(REDMI).state==='break')f.at(f.pacer.state(REDMI).until);
 }
 const real=gaps.filter(g=>g<=30000);
 assert.ok(real.every(g=>g>=3000&&g<=30000));
 assert.ok(new Set(real.map(g=>Math.round(g/10))).size>100,'gaps must not repeat a fixed value');
 const sorted=[...real].sort((a,b)=>a-b),median=sorted[sorted.length>>1];
 assert.ok(median>5000&&median<12000,'median near 8 s: '+median);
});

test('a run of items is followed by a short break and the daily cap stops the device',t=>{
 const f=pacing(t,afternoon);f.at(afternoon+60000);let breaks=0;
 for(let i=0;i<400;i++){
  let st=f.pacer.state(REDMI);
  while(st.state!=='ready'){if(st.state==='break')breaks++;f.at(st.until);st=f.pacer.state(REDMI);}
  f.pacer.started(REDMI);f.pacer.finished(REDMI);
 }
 assert.ok(breaks>=10,'breaks after runs: '+breaks);
 f.at(f.now()+HOUR);
 assert.equal(f.pacer.state(REDMI).state,'daily_cap');
 assert.equal(f.pacer.view(REDMI).count,400);
 f.at(localDay(f.now())+DAY+15*HOUR);
 assert.equal(f.pacer.state(REDMI).state,'ready','a new day resets the cap');
});

test('profile visits come in short runs with a break, other operations keep the long burst',t=>{
 const f=pacing(t,afternoon);f.at(afternoon+60000);
 const run=[],other=[];let n=0;
 for(let i=0;i<60;i++){
  let st=f.pacer.state(REDMI);
  while(st.state!=='ready'){if(st.state==='break'){run.push(n);n=0;}f.at(st.until);st=f.pacer.state(REDMI);}
  f.pacer.started(REDMI,'profile.posts');f.pacer.finished(REDMI,null,f.now(),'profile.posts');n++;
 }
 assert.ok(run.length>=3,'breaks: '+run);
 // A general burst break can cut a run short; a run never exceeds 16.
 assert.ok(run.every(k=>k>=1&&k<=16),'runs of at most 16 profiles: '+run);
 assert.ok([...run].sort((a,b)=>a-b)[run.length>>1]>=10,'most runs are 10-16: '+run);
 const g=pacing(t,afternoon);g.at(afternoon+60000);n=0;
 for(let i=0;i<40;i++){
  let st=g.pacer.state(REDMI);
  while(st.state!=='ready'){if(st.state==='break'){other.push(n);n=0;}g.at(st.until);st=g.pacer.state(REDMI);}
  g.pacer.started(REDMI,'search.posts');g.pacer.finished(REDMI,null,g.now(),'search.posts');n++;
 }
 assert.ok(other.every(k=>k>=20&&k<=35),'searches keep the 20-35 burst: '+other);
});

test('the two phones sleep at different times so one phone is always awake',t=>{
 const f=pacing(t,afternoon);let redmiSlept=0,oneplusSlept=0;
 for(let day=0;day<60;day++)for(let m=0;m<DAY;m+=10*MIN){
  const now=afternoon+day*DAY+m;
  const a=!!f.pacer.sleepWindow(REDMI,now),b=!!f.pacer.sleepWindow(ONEPLUS,now);
  assert.ok(!(a&&b),'both phones asleep at '+new Date(now).toISOString());
  redmiSlept+=a;oneplusSlept+=b;
 }
 assert.ok(redmiSlept>60*30&&oneplusSlept>60*30,'each phone sleeps about six hours a day');
 assert.equal(f.pacer.sleepWindow('web:xhs:default',afternoon),null);
});

test('a detection signal brakes the device, slows it afterwards, and a repeat stops it for the day',t=>{
 const f=pacing(t,afternoon);f.at(afternoon+60000);
 f.pacer.started(ONEPLUS);f.pacer.finished(ONEPLUS,'XHS_ACCESS_RESTRICTED');
 const brake=f.pacer.state(ONEPLUS);
 assert.equal(brake.state,'brake');assert.ok(brake.until-f.now()>=45*MIN&&brake.until-f.now()<=90*MIN);
 f.at(brake.until);
 f.pacer.started(ONEPLUS);f.pacer.finished(ONEPLUS);
 assert.ok(f.pacer.state(ONEPLUS).until-f.now()>=3000*1.5-1,'slowed gap after a brake');
 f.at(f.pacer.state(ONEPLUS).until);
 f.pacer.started(ONEPLUS);f.pacer.finished(ONEPLUS,'UI_BLOCKED_BY_OVERLAY');
 const stopped=f.pacer.state(ONEPLUS);
 assert.equal(stopped.state,'brake');assert.ok(stopped.until>=localDay(f.now())+DAY);
 assert.equal(f.store.events(null).filter(e=>e.type==='device.pacing_brake').length,2);
 f.pacer.started(REDMI);f.pacer.finished(REDMI,'NATIVE_DETAIL_BODY_UNOBSERVED');
 assert.equal(f.pacer.state(REDMI).state,'gap','ordinary item errors do not brake');
});

test('pacing state survives a restart of the service',t=>{
 const f=pacing(t,afternoon);f.at(afternoon+60000);
 f.pacer.started(REDMI);f.pacer.finished(REDMI,'VERIFICATION_REQUIRED');
 const again=new Pacer(f.store,profile,{now:f.now});
 assert.equal(again.state(REDMI).state,'brake');assert.equal(again.view(REDMI).count,1);
});

function screen(labels){return labels.map((text,i)=>({text,package:'com.xingin.xhs',center:[540,200+i*100],width:600,height:80,clickable:'true',enabled:'true'}));}
function fakeAdb(views){
 const commands=[],incidents=[];let index=0;
 return {commands,incidents,adb:{ui:async()=>views[Math.min(index++,views.length-1)],shell:async(...a)=>{commands.push(a);},tap:async n=>{commands.push(['tap',n.text]);},
  wait:async()=>{},logIncident:e=>incidents.push(e)}};
}

test('the XHS update prompt is dismissed with "later" and never installed',async()=>{
 const dialog=screen(['免流量升级','立即安装','稍后再说']),grid=screen(['笔记','粉丝']);
 const f=fakeAdb([dialog,grid]);
 const nav=new XhsNavigation(f.adb,{guard:()=>{}});
 const nodes=await nav.ui();
 assert.deepEqual(nodes.map(n=>n.text),['笔记','粉丝']);
 assert.deepEqual(f.commands,[['tap','稍后再说']]);
 assert.equal(f.incidents[0].dialog,'xhs_update_prompt');
});

test('pagination stops after two swipes leave the screen unchanged and names the overlay',async()=>{
 const stuck=screen(['笔记','粉丝','允许']);
 const f=fakeAdb([stuck]);
 const nav=new XhsNavigation(f.adb,{guard:()=>{},random:Math.random});
 await assert.rejects(nav.nextPage(()=>false,{maxSwipes:12}),{code:'UI_BLOCKED_BY_OVERLAY'});
 assert.equal(f.commands.filter(c=>c[1]==='swipe').length<=4,true);
 assert.equal(f.incidents.at(-1).kind,'ui_blocked');assert.equal(f.incidents.at(-1).overlay,'prompt:允许');
});

test('swipes vary in column, length, drift and speed',async()=>{
 const views=Array.from({length:60},(_,i)=>screen(['笔记 '+i,'粉丝']).concat({text:'',center:[540,1170],width:1080,height:2340}));
 const f=fakeAdb(views);
 const nav=new XhsNavigation(f.adb,{guard:()=>{}});
 for(let i=0;i<50;i++)await nav.swipe(1);
 const swipes=f.commands.filter(c=>c[1]==='swipe').map(c=>c.slice(2).join(','));
 assert.ok(new Set(swipes).size/swipes.length>=.9);
 for(const s of swipes){const [x0,y0,,y1,ms]=s.split(',').map(Number);assert.ok(x0>=1080*.3&&x0<=1080*.7);assert.ok(ms>=250&&ms<=650);assert.ok(y0!==y1);}
});

test('input evidence is one JSON line per event and old days are pruned',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'input-log-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.writeFileSync(path.join(dir,'2026-01-01.jsonl'),'{}\n');
 let now=Date.UTC(2026,10,27,6);const log=createInputLog(dir,{now:()=>now});
 log('android:x',describeInput(['input','swipe','1','2','3','4','400']));
 log('android:x',describeInput(['am','start','-a','android.intent.action.VIEW','-d','xhsdiscover://item/'+'a'.repeat(24),'-p','com.xingin.xhs']));
 const files=fs.readdirSync(dir);assert.deepEqual(files,['2026-11-27.jsonl']);
 const lines=fs.readFileSync(path.join(dir,files[0]),'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(lines[0].kind,'swipe');assert.deepEqual(lines[0].values,[1,2,3,4,400]);
 assert.equal(lines[1].kind,'open_link');assert.ok(!lines[1].target.includes('a'.repeat(24)));
 assert.equal(describeInput(['uiautomator','dump','/sdcard/x.xml']),null);
});

test('warm-up sessions are short daytime windows and likes have a daily budget',t=>{
 const store=new Store(':memory:');t.after(()=>store.close());
 store.register({id:REDMI,kind:'android',serial:'7e9c701e',capabilities:[{platform:'xiaohongshu',operation:'post.detail'}]});
 const warmup=new PhoneWarmup(store,{},{browse:async()=>{},sessions:true});
 const day=localDay(Date.UTC(2026,10,27,6));
 warmup.plan(REDMI,day);
 const row=store.db.prepare('SELECT * FROM phone_warmup WHERE device_id=?').get(REDMI);
 const windows=JSON.parse(row.windows);
 // 2.5-3.5 h in 20-40 min sessions: between 4 and 11 of them.
 assert.ok(windows.length>=4&&windows.length<=11,'sessions: '+windows.length);
 for(const [from,to] of windows){assert.ok(from>=day+10*HOUR&&to<=day+23*HOUR);assert.ok(to-from<=40*MIN);}
 for(let i=1;i<windows.length;i++)assert.ok(windows[i][0]-windows[i-1][1]>=25*MIN);
 let liked=0;for(let i=0;i<20;i++)liked+=warmup.likeOk(REDMI,day);assert.equal(liked,8);
 assert.equal(warmup.inSession(REDMI,{...row,manual:0},windows[0][0]+MIN),true);
 assert.equal(warmup.inSession(REDMI,{...row,manual:0},windows[0][1]+MIN),false);
});

test('Web XHS operations can be kept on phones only',t=>{
 const {registerWebAdapters}=require('../service/web_adapters');
 const store=new Store(':memory:');t.after(()=>store.close());
 registerWebAdapters(store,{env:{CRAWLER_XHS_WEB_ENABLED:'true',CRAWLER_XHS_WEB_EXCLUDE:'search.posts'}});
 const ops=store.devices().find(d=>d.id==='web:xhs:default').capabilities.map(c=>c.operation);
 assert.ok(!ops.includes('search.posts'));assert.ok(ops.includes('post.detail'));
});

test('warm-up closes and reopens XHS once when Back cannot reach Home through stacked pages',async()=>{
 const {browseFeed}=require('../adapters/xhs-phone/warmup');
 const XHS='com.xingin.xhs',node=(text,extra={})=>({text,package:XHS,center:[200,350],width:400,height:700,...extra});
 const profile=[node('Notes'),node('Follow')],home=[node('首页'),node('发现'),node('图文,样本,来自作者,12赞',{clickable:'true'})];
 const commands=[];let restarted=false,reads=0;
 const adb={ui:async()=>{reads++;if(restarted&&reads>40)throw Object.assign(Error('STOP'),{code:'STOP'});return restarted?home:profile;},
  shell:async(...a)=>{commands.push(a.join(' '));if(a[0]==='am'&&a[1]==='force-stop')restarted=true;},tap:async()=>{},wait:async()=>{}};
 // After reaching Home it opens a card; the fixture has no post page, so it stops there.
 await assert.rejects(browseFeed(adb,{guard:()=>{},dwell:async()=>{},random:()=>0}),error=>error.code!=='WARMUP_HOME_UNCONFIRMED');
 assert.equal(commands.filter(c=>c==='am force-stop com.xingin.xhs').length,1);
 assert.ok(commands.filter(c=>c==='input keyevent 4').length>=6);
});
