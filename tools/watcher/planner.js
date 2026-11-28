'use strict';
// Daily activity plan for the web XHS account, made by the watcher:
//  - follow proposals: up to FOLLOWS_PER_DAY creators from the newest KOL
//    lists (50k+ fans, Shanghai mention first); they run after a notice window
//    unless a person rejects them
//  - post drafts: for each new photo set in <publish root>/inbox/<set>/, the
//    local model writes a Chinese title/body/tags; nothing is posted until a
//    person approves the draft
//  - one English Feishu message with the plan and the reply commands
//  - approvals: "approve P3" / "reject F12" replies in the Feishu chat, read
//    only from FEISHU_APPROVER_OPEN_ID (needs the app's group-message read scope)
const fs=require('node:fs'),path=require('node:path');

const MIN=60000,HOUR=60*MIN,DAY=24*HOUR,OFFSET=8*HOUR;
const localDay=ms=>Math.floor((ms+OFFSET)/DAY)*DAY-OFFSET;
const FOLLOWS_PER_DAY=5,PLAN_AT=9.5*HOUR,MIN_FANS=50000;
const IMAGE=/\.(jpe?g|png|webp)$/i;
const WEB='web:xhs:default';

class Planner {
 constructor(watcher,{publishRoot=process.env.XHS_PUBLISH_ROOT||path.join(process.env.HOME||'.','xhs-posts')}={}){
  this.w=watcher;this.publishRoot=publishRoot;
  const s=watcher.state;s.plan=s.plan||{days:{},drafted:{},feishuCursor:null};
 }
 get state(){return this.w.state.plan;}
 async api(method,route,body){
  const svc=this.w.service();if(!svc)throw Object.assign(Error('SERVICE_UNCONFIGURED'),{code:'SERVICE_UNCONFIGURED'});
  const res=await this.w.fetchImpl(svc.url.replace(/\/$/,'')+route,{method,headers:{Authorization:'Bearer '+svc.token,'Content-Type':'application/json'},
   body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
  const value=await res.json().catch(()=>({}));
  if(!res.ok)throw Object.assign(Error(value.error?.code||'HTTP_'+res.status),{code:value.error?.code||'HTTP_'+res.status});
  return value;
 }
 // Newest decide lists from KOL runs, best candidates first.
 candidates(){
  const runs=path.join(this.w.analysisRoot,'runtime','kol-runs');let files=[];
  try{for(const run of fs.readdirSync(runs)){const dir=path.join(runs,run,'artifacts','decide');
   try{for(const f of fs.readdirSync(dir))if(/^list_.*\.json$/.test(f))files.push(path.join(dir,f));}catch{}}}catch{}
  files.sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);
  const rows=[];
  for(const f of files.slice(0,5)){try{for(const r of JSON.parse(fs.readFileSync(f,'utf8')))
   if(/^[a-f0-9]{24}$/i.test(r.uid||'')&&(r.followers||0)>=MIN_FANS)rows.push({...r,project:path.basename(path.dirname(path.dirname(path.dirname(f))))});}catch{}}
  // Shanghai creators first, then mid-size before the very largest.
  const score=r=>(r.city_mentioned?0:1)*10+(r.followers>=1e6?1:0);
  return rows.sort((a,b)=>score(a)-score(b)||b.followers-a.followers);
 }
 photoSets(){
  const inbox=path.join(this.publishRoot,'inbox');let sets=[];
  try{sets=fs.readdirSync(inbox,{withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>d.name).sort();}catch{}
  return sets.filter(s=>!this.state.drafted[s]).map(name=>{
   const dir=path.join(inbox,name);
   const images=fs.readdirSync(dir).filter(f=>IMAGE.test(f)).sort().slice(0,9).map(f=>path.join(dir,f));
   let note='';try{note=fs.readFileSync(path.join(dir,'note.txt'),'utf8').slice(0,1500);}catch{}
   return {name,images,note};
  }).filter(s=>s.images.length);
 }
 async draft(set){
  const answer=await this.w.ask('你为一个上海生活方式小红书账号写笔记草稿。只用给出的信息，不编造店名、价格或经历。返回JSON：{"title":"不超过20个字","content":"150-500字，口语，分段","tags":["3到6个话题，不带#"]}。只返回JSON。',
   JSON.stringify({photos:set.images.map(p=>path.basename(p)),owner_note:set.note}),{maxTokens:1500});
  if(!answer)return null;
  try{
   const j=JSON.parse(answer.replace(/^```(?:json)?|```$/g,'').trim());
   if(typeof j.title!=='string'||typeof j.content!=='string')return null;
   return {title:[...j.title].slice(0,20).join(''),content:[...j.content].slice(0,1000).join(''),
    tags:Array.isArray(j.tags)?j.tags.filter(t=>typeof t==='string').slice(0,6):[],images:set.images,visibility:'公开可见',set:set.name};
  }catch{return null;}
 }
 async daily(now){
  const day=localDay(now),key=String(day);
  if(now-day<PLAN_AT||this.state.days[key])return null;
  const follows=[],drafts=[],errors=[];
  for(const c of this.candidates()){
   if(follows.length>=FOLLOWS_PER_DAY)break;
   try{
    const a=await this.api('POST','/v1/activities',{kind:'follow',device_id:WEB,payload:{user_id:c.uid,nickname:c.nickname,followers:c.followers},note:c.project});
    if(a.state==='proposed'&&a.created>=day)follows.push(a);
   }catch(e){errors.push(e.code);break;}
  }
  for(const set of this.photoSets().slice(0,1)){
   const d=await this.draft(set);
   if(!d){errors.push('DRAFT_UNAVAILABLE');continue;}
   try{drafts.push(await this.api('POST','/v1/activities',{kind:'publish',device_id:WEB,payload:d,note:'set '+set.name}));this.state.drafted[set.name]=day;}
   catch(e){errors.push(e.code);}
  }
  this.state.days[key]={follows:follows.map(a=>a.id),drafts:drafts.map(a=>a.id)};
  const when=a=>new Date(a.auto_at+OFFSET).toISOString().slice(11,16);
  const text=['Crawler activity plan for today (web XHS account)',
   follows.length?'Follows (run automatically after the time shown unless you reply "reject F<id>"):':'Follows: none proposed today.',
   ...follows.map(a=>`- F${a.id} ${a.payload.nickname||''} (${Math.round((a.payload.followers||0)/1000)}k fans) after ${when(a)}`),
   ...drafts.flatMap(a=>[`Post draft P${a.id} (needs "approve P${a.id}"; "reject P${a.id}" drops it):`,`  Title: ${a.payload.title}`,`  ${a.payload.content.slice(0,160).replace(/\n/g,' ')}…`,`  Tags: ${a.payload.tags.join(', ')} | ${a.payload.images.length} photos`]),
   errors.length?`Problems: ${[...new Set(errors)].join(', ')}`:'',
   'Browsing runs in the crawl breaks. Commands also work on hpc: node tools/fleetctl.js approve P<id>'].filter(Boolean).join('\n');
  this.w.journal('activity plan',text);
  await this.w.feishu(text);
  return {follows:follows.length,drafts:drafts.length};
 }
 // Feishu replies from the approver only. Without the read scope or approver
 // id this does nothing; fleetctl approve/reject always works.
 async approvals(){
  const env=this.w.env?this.w.env():{};
  if(!env.FEISHU_APPROVER_OPEN_ID)return 0;
  const token=await this.w.feishuToken?.();if(!token)return 0;
  const O='https://open.feishu.cn/open-apis';
  const r=await (await this.w.fetchImpl(O+'/im/v1/messages?container_id_type=chat&container_id='+env.FEISHU_CHAT_ID+'&sort_type=ByCreateTimeDesc&page_size=20',
   {headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(15000)})).json();
  if(r.code!==0)return 0;
  const items=(r.data?.items||[]).filter(m=>m.sender?.sender_type==='user'&&m.sender.id===env.FEISHU_APPROVER_OPEN_ID&&m.msg_type==='text')
   .sort((a,b)=>Number(a.create_time)-Number(b.create_time));
  const cursor=this.state.feishuCursor;let n=0;
  // First run only sets the cursor: messages from before it are never acted on.
  if(!cursor){this.state.feishuCursor=Math.max(this.w.now(),...items.map(m=>Number(m.create_time)));return 0;}
  for(const m of items){
   if(cursor&&Number(m.create_time)<=cursor)continue;
   this.state.feishuCursor=Number(m.create_time);
   let text='';try{text=JSON.parse(m.body?.content||'{}').text||'';}catch{}
   const cmd=text.trim().match(/^(approve|reject)\s+([FP])(\d+)$/i);
   if(!cmd)continue;
   try{const a=await this.api('POST',`/v1/activities/${cmd[3]}/${cmd[1].toLowerCase()}`,{by:'feishu'});
    await this.w.feishu(`${cmd[2].toUpperCase()}${a.id} ${a.state}.`);n++;}
   catch(e){await this.w.feishu(`${cmd[2].toUpperCase()}${cmd[3]}: ${e.code}`);}
  }
  return n;
 }
 async cycle(now){
  try{await this.daily(now);}catch(e){this.w.journal('activity plan failed',String(e.code||e.message));}
  try{await this.approvals();}catch{}
 }
}
module.exports={Planner,FOLLOWS_PER_DAY};
