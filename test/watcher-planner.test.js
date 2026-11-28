'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Planner}=require('../tools/watcher/planner');

const HOUR=3600000,OFFSET=8*HOUR;
const day=Date.parse('2026-11-20T00:00:00+08:00');
function fixture(t,{approver=null,draft='{"title":"上海一人食小馆","content":"今天去了…","tags":["上海美食"]}'}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'planner-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const decide=path.join(root,'analysis','runtime','kol-runs','food-run','artifacts','decide');fs.mkdirSync(decide,{recursive:true});
 const rows=Array.from({length:9},(_,i)=>({uid:String(i).repeat(24).slice(0,24).replace(/[^0-9]/g,'a'),nickname:'k'+i,followers:[30000,2e6,80000,60000,120000,70000,90000,55000,65000][i],city_mentioned:i%2===0}));
 fs.writeFileSync(path.join(decide,'list_food.json'),JSON.stringify(rows));
 const set=path.join(root,'posts','inbox','2026-11-20-noodles');fs.mkdirSync(set,{recursive:true});
 fs.writeFileSync(path.join(set,'a.jpg'),'x');fs.writeFileSync(path.join(set,'note.txt'),'静安一家面馆');
 let now=day+10*HOUR,id=0;const posted=[],sent=[],decided=[];let messages=[];
 const fetchImpl=async(url,opts={})=>{
  const ok=v=>({ok:true,status:200,json:async()=>v});
  if(url.includes('/v1/activities/')){const [,aid,action]=url.match(/activities\/(\d+)\/(\w+)/);decided.push([aid,action]);return ok({id:Number(aid),state:action==='approve'?'approved':'rejected'});}
  if(url.endsWith('/v1/activities')){const b=JSON.parse(opts.body);posted.push(b);id++;return ok({id,kind:b.kind,state:'proposed',created:now,auto_at:now+2*HOUR,payload:b.payload});}
  if(url.includes('/im/v1/messages?container_id_type'))return ok({code:0,data:{items:messages}});
  throw new Error('unexpected '+url);
 };
 const w={state:{},analysisRoot:path.join(root,'analysis'),fetchImpl,now:()=>now,service:()=>({url:'http://svc',token:'t'}),
  ask:async()=>draft,feishu:async text=>{sent.push(text);return true;},feishuToken:async()=>'tok',journal:()=>{},
  env:()=>({FEISHU_CHAT_ID:'c',...(approver?{FEISHU_APPROVER_OPEN_ID:approver}:{})})};
 const planner=new Planner(w,{publishRoot:path.join(root,'posts')});
 return {planner,posted,sent,decided,setNow:v=>{now=v;},setMessages:m=>{messages=m;}};
}

test('the daily plan proposes five 50k+ follows, Shanghai first, and one draft, then reports in English once',async t=>{
 const f=fixture(t);
 f.setNow(day+9*HOUR);
 assert.equal(await f.planner.daily(day+9*HOUR),null,'not before 09:30');
 const r=await f.planner.daily(day+10*HOUR);
 assert.deepEqual(r,{follows:5,drafts:1});
 const follows=f.posted.filter(p=>p.kind==='follow');
 assert.equal(follows.length,5);
 assert.ok(follows.every(p=>p.payload.followers>=50000));
 assert.ok(follows.slice(0,3).every(p=>['k2','k4','k6','k8'].includes(p.payload.nickname)),'Shanghai creators first');
 const draft=f.posted.find(p=>p.kind==='publish');
 assert.equal(draft.payload.title,'上海一人食小馆');
 assert.ok(draft.payload.images[0].endsWith('a.jpg'));
 assert.match(f.sent[0],/^Crawler activity plan/);
 assert.match(f.sent[0],/reject F1/);assert.match(f.sent[0],/approve P6/);
 assert.equal(await f.planner.daily(day+11*HOUR),null,'once a day');
 assert.equal(f.planner.photoSets().length,0,'a drafted set is not drafted again');
});

test('a model answer that is not a draft creates no post',async t=>{
 const f=fixture(t,{draft:'sorry'});
 await f.planner.daily(day+10*HOUR);
 assert.equal(f.posted.filter(p=>p.kind==='publish').length,0);
 assert.match(f.sent[0],/DRAFT_UNAVAILABLE/);
});

test('Feishu approvals come only from the approver and only after the first look',async t=>{
 const none=fixture(t);
 assert.equal(await none.planner.approvals(),0,'no approver configured');
 const f=fixture(t,{approver:'ou_me'});
 const msg=(time,sender,text)=>({create_time:String(time),msg_type:'text',sender:{sender_type:'user',id:sender},body:{content:JSON.stringify({text})}});
 f.setMessages([msg(day+HOUR,'ou_me','approve P3')]);
 assert.equal(await f.planner.approvals(),0,'old messages are not acted on');
 f.setNow(day+11*HOUR);
 f.setMessages([msg(day+HOUR,'ou_me','approve P3'),msg(day+12*HOUR,'ou_partner','approve P4'),msg(day+12*HOUR+1,'ou_me','reject F7'),msg(day+12*HOUR+2,'ou_me','approve everything')]);
 assert.equal(await f.planner.approvals(),1);
 assert.deepEqual(f.decided,[['7','reject']]);
 assert.equal(await f.planner.approvals(),0,'a message is handled once');
});
