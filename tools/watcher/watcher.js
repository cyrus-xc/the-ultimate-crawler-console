'use strict';
// Crawler watcher: one of the agent-work watchers that share the local DeepSeek
// model. Code rules run every cycle; the model is asked only to explain a
// detection and to write summaries (never a paid API, at most LLM_PER_HOUR).
// It never changes settings, pacing or requests. Its one write is a whitelisted
// self-fix: after a transient phone failure (UI observation miss, App crash,
// observer detach) and a 2-5 minute rest it asks the service's own guarded
// connection repair to return the phone, at most FIX_PER_DAY per phone. Every
// other condition (login/verification, disconnection, version mismatch, three
// failures in a row, a failed or exhausted fix) is a Feishu alert with @All.
// Records share one shape across watchers: agent, at, and status.json.
// It runs until WATCHER_UNTIL when set, otherwise permanently.
const fs=require('node:fs'),path=require('node:path');
const Database=require('better-sqlite3');

const MIN=60000,HOUR=60*MIN,DAY=24*HOUR,OFFSET=8*HOUR;
const localDay=ms=>Math.floor((ms+OFFSET)/DAY)*DAY-OFFSET;
const stamp=ms=>new Date(ms+OFFSET).toISOString().slice(0,16).replace('T',' ');
const AGENT='crawler',FIX_PER_DAY=3,LLM_PER_HOUR=6;
const SELF_FIX=new Set(['PHONE_FIRST_PAGE_UNOBSERVED','PHONE_PAGE_RESPONSE_UNOBSERVED','UI_BLOCKED_BY_OVERLAY',
 'APP_MAIN_PROCESS_MISMATCH','APP_NOT_READY','OBSERVER_DETACHED']);
const DETECTION=new Set(['VERIFICATION_REQUIRED','CRAWLER_VERIFICATION_REQUIRED','LOGIN_OR_VERIFICATION_REQUIRED','LOGIN_REQUIRED',
 'XHS_ACCESS_RESTRICTED','CRAWLER_ACCESS_RESTRICTED','ACCESS_RESTRICTED','UI_BLOCKED_BY_OVERLAY','PHONE_CAPTCHA']);

function readEnv(file){
 const env={};try{for(const line of fs.readFileSync(file,'utf8').split('\n')){const m=line.match(/^([A-Z0-9_]+)=(.*)$/);if(m)env[m[1]]=m[2].trim().replace(/^"|"$/g,'');}}catch{}
 return env;
}

class Watcher {
 constructor({runtime,analysisRoot,until=Infinity,intervalMs=5*MIN,now=Date.now,fetchImpl=fetch,startedAt,service}){
  Object.assign(this,{runtime,analysisRoot,until,intervalMs,now,fetchImpl,serviceOverride:service});
  this.dir=path.join(runtime,'watcher');fs.mkdirSync(this.dir,{recursive:true,mode:0o700});
  this.stateFile=path.join(this.dir,'state.json');
  this.state={cursor:0,eventCursor:0,inputOffsets:{},alerts:{},summaries:{},fixes:{},llm:[],startedAt:startedAt||now(),...this.load()};
  this.state.fixes=this.state.fixes||{};this.state.llm=this.state.llm||[];
  this.db=new Database(path.join(runtime,'queue.db'),{readonly:true,fileMustExist:true});
  this.db.pragma('query_only = ON');
  // The first start watches from now: history is not re-analysed.
  if(this.state.cursor===0&&!fs.existsSync(this.stateFile)){
   this.state.cursor=this.db.prepare('SELECT coalesce(max(rowid),0) n FROM attempts').get().n;
   try{for(const name of fs.readdirSync(path.join(runtime,'input-log')))this.state.inputOffsets[name]=fs.statSync(path.join(runtime,'input-log',name)).size;}catch{}
  }
 }
 has(table){return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);}
 load(){try{return JSON.parse(fs.readFileSync(this.stateFile,'utf8'));}catch{return {};}}
 save(){fs.writeFileSync(this.stateFile+'.tmp',JSON.stringify(this.state));fs.renameSync(this.stateFile+'.tmp',this.stateFile);}
 append(name,line){fs.appendFileSync(path.join(this.dir,name),line,{mode:0o600});}
 journal(title,body){this.append('journal.md',`\n## ${stamp(this.now())} ${title}\n\n${body.trim()}\n`);}

 // ---- evidence ----
 attemptsSince(cursor){
  return this.db.prepare(`SELECT a.rowid seq,a.device_id,a.state,a.started,a.finished,a.error,json_extract(r.payload,'$.operation') op
   FROM attempts a JOIN units u ON u.id=a.unit_id JOIN requests r ON r.id=u.request_id
   WHERE a.rowid>? AND a.finished IS NOT NULL ORDER BY a.rowid`).all(cursor);
 }
 attemptsAround(device,from,to){
  return this.db.prepare(`SELECT a.started,a.finished,a.state,a.error,json_extract(r.payload,'$.operation') op FROM attempts a
   JOIN units u ON u.id=a.unit_id JOIN requests r ON r.id=u.request_id WHERE a.device_id=? AND a.started BETWEEN ? AND ? ORDER BY a.started`).all(device,from,to);
 }
 inputs(device,from,to){
  const out=[];
  for(let day=localDay(from);day<=to;day+=DAY){
   const file=path.join(this.runtime,'input-log',new Date(day+OFFSET).toISOString().slice(0,10)+'.jsonl');
   let text;try{text=fs.readFileSync(file,'utf8');}catch{continue;}
   for(const line of text.split('\n')){if(!line)continue;let e;try{e=JSON.parse(line);}catch{continue;}if(e.device_id===device&&e.at>=from&&e.at<=to)out.push(e);}
  }
  return out;
 }
 newIncidentsFromLog(){
  const dir=path.join(this.runtime,'input-log'),found=[];
  let files=[];try{files=fs.readdirSync(dir).filter(f=>f.endsWith('.jsonl')).sort();}catch{return found;}
  for(const name of files){
   const file=path.join(dir,name),size=fs.statSync(file).size,offset=this.state.inputOffsets[name]||0;
   if(size<=offset)continue;
   const fd=fs.openSync(file,'r'),buffer=Buffer.alloc(size-offset);fs.readSync(fd,buffer,0,buffer.length,offset);fs.closeSync(fd);
   const text=buffer.toString('utf8'),complete=text.lastIndexOf('\n')+1;
   for(const line of text.slice(0,complete).split('\n')){if(!line)continue;try{const e=JSON.parse(line);if(e.kind==='ui_blocked'||e.kind==='dialog_dismissed')found.push(e);}catch{}}
   this.state.inputOffsets[name]=offset+Buffer.byteLength(text.slice(0,complete));
  }
  return found;
 }
 sequence(device,at){
  const from=at-30*MIN,attempts=this.attemptsAround(device,from,at+MIN),inputs=this.inputs(device,from,at+MIN);
  const kinds={};for(const e of inputs)kinds[e.kind]=(kinds[e.kind]||0)+1;
  const gaps=[];for(let i=1;i<attempts.length;i++)if(attempts[i-1].finished)gaps.push(Math.round((attempts[i].started-attempts[i-1].finished)/1000));
  const pacing=this.has('device_pacing')?this.db.prepare('SELECT * FROM device_pacing WHERE device_id=?').get(device)||null:null;
  return {window_min:30,items:attempts.map(a=>({t:Math.round((a.started-at)/1000),op:a.op,secs:a.finished?Math.round((a.finished-a.started)/1000):null,state:a.state,code:a.error?JSON.parse(a.error).code:null})),
   gaps_s:gaps,input_counts:kinds,last_inputs:inputs.slice(-40).map(e=>({t:Math.round((e.at-at)/1000),kind:e.kind,v:e.values||e.target||e.dialog||e.overlay})),
   pacing:pacing&&{count_today:pacing.count,burst_left:pacing.burst_left,slowed:pacing.slow_until>at,last_brake_at:pacing.last_brake_at}};
 }

 // ---- local model ----
 llmSource(){
  try{
   const settings=JSON.parse(fs.readFileSync(path.join(this.analysisRoot,'runtime','llm-settings.json'),'utf8'));
   const catalog=JSON.parse(fs.readFileSync(path.join(this.analysisRoot,'core','llm','sources.json'),'utf8'));
   const source=catalog[settings.agent||settings.pipeline];
   return source?.provider==='local'?source:null;   // never a metered source
  }catch{return null;}
 }
 async ask(system,user,{maxTokens=600}={}){
  const source=this.llmSource();if(!source)return null;
  // The model is shared with other agent work; keep this watcher's share small.
  const now=this.now();this.state.llm=this.state.llm.filter(t=>t>now-HOUR);
  if(this.state.llm.length>=LLM_PER_HOUR)return null;
  this.state.llm.push(now);
  try{
   const res=await this.fetchImpl(source.base_url.replace(/\/$/,'')+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({model:source.model,temperature:0.2,max_tokens:maxTokens,reasoning_effort:'low',messages:[{role:'system',content:system},{role:'user',content:user}]}),
    signal:AbortSignal.timeout(300000)});
   if(!res.ok)return null;const body=await res.json();
   return String(body.choices?.[0]?.message?.content||'').trim()||null;
  }catch{return null;}
 }

 // ---- Feishu ----
 env(){return readEnv(path.join(this.analysisRoot,'.env'));}
 async feishuToken(){
  const env=this.env(),secret=env.FEISHU_APP_SECRET||env.PIPELINE_AGENT_APP_SECRET;
  if(!env.FEISHU_APP_ID||!secret)return null;
  try{const t=await (await this.fetchImpl('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({app_id:env.FEISHU_APP_ID,app_secret:secret}),signal:AbortSignal.timeout(15000)})).json();return t.tenant_access_token||null;}catch{return null;}
 }
 async feishu(text,{all=false}={}){
  const env=readEnv(path.join(this.analysisRoot,'.env')),secret=env.FEISHU_APP_SECRET||env.PIPELINE_AGENT_APP_SECRET;
  if(!env.FEISHU_APP_ID||!secret||!env.FEISHU_CHAT_ID)return false;
  try{
   const O='https://open.feishu.cn/open-apis';
   const t=await (await this.fetchImpl(O+'/auth/v3/tenant_access_token/internal',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({app_id:env.FEISHU_APP_ID,app_secret:secret}),signal:AbortSignal.timeout(15000)})).json();
   if(!t.tenant_access_token)return false;
   const content={text:(all?'<at user_id="all">All</at>\n':'')+text};
   const r=await (await this.fetchImpl(O+'/im/v1/messages?receive_id_type=chat_id',{method:'POST',headers:{Authorization:'Bearer '+t.tenant_access_token,'Content-Type':'application/json'},
    body:JSON.stringify({receive_id:env.FEISHU_CHAT_ID,msg_type:'text',content:JSON.stringify(content)}),signal:AbortSignal.timeout(15000)})).json();
   return r.code===0;
  }catch{return false;}
 }

 // ---- crawler service (the self-fix uses only its guarded repair route) ----
 service(){
  if(this.serviceOverride)return this.serviceOverride;
  const env=readEnv(path.join(this.analysisRoot,'.env')),home=process.env.HOME||'';
  const file=(env.CRAWLER_SERVICE_TOKEN_FILE||'').replace('$HOME',home).replace(/^~(?=\/)/,home);
  try{return env.CRAWLER_SERVICE_URL&&file?{url:env.CRAWLER_SERVICE_URL,token:fs.readFileSync(file,'utf8').trim()}:null;}catch{return null;}
 }
 async repair(id){
  const service=this.service();if(!service)return {ok:false,code:'SERVICE_UNCONFIGURED'};
  try{
   const res=await this.fetchImpl(service.url.replace(/\/$/,'')+'/v1/devices/repair-connection',{method:'POST',
    headers:{Authorization:'Bearer '+service.token,'Content-Type':'application/json'},body:JSON.stringify({device_id:id}),signal:AbortSignal.timeout(120000)});
   const body=await res.json().catch(()=>({}));
   return res.ok&&body.health==='ready'?{ok:true}:{ok:false,code:body.code||body.error||'HTTP_'+res.status};
  }catch(error){return {ok:false,code:error.name==='TimeoutError'?'REPAIR_TIMEOUT':'REPAIR_UNREACHABLE'};}
 }
 // Decide for one unavailable phone: rest, fix now, or alert a person.
 fixPlan(d,now){
  const rows=this.db.prepare('SELECT rowid seq,state,error,finished FROM attempts WHERE device_id=? AND finished IS NOT NULL ORDER BY rowid DESC LIMIT 3').all(d.id);
  const last=rows[0];if(!last||last.state!=='failed')return {alert:'PHONE_NEEDS_REPAIR'};
  let code=null;try{code=JSON.parse(last.error).code;}catch{}
  if(!SELF_FIX.has(code))return {alert:'PHONE_NEEDS_REPAIR:'+(code||'UNKNOWN')};
  if(rows.length===3&&rows.every(r=>r.state==='failed'))return {alert:'FAILED_IN_ROW_3:'+code};
  const day=localDay(now),fixes=this.state.fixes[d.id]?.day===day?this.state.fixes[d.id]:{day,n:0};
  if(fixes.lastSeq===last.seq)return {alert:'SELF_FIX_FAILED:'+(fixes.lastResult||code)};
  if(fixes.n>=FIX_PER_DAY)return {alert:'SELF_FIX_LIMIT:'+code};
  const rest=2*MIN+(last.seq%181)*1000;   // a 2-5 minute rest, stable per incident
  if(now-last.finished<rest)return {wait:true};
  return {fix:{seq:last.seq,code,fixes}};
 }
 async selfFix(d,plan){
  const result=await this.repair(d.id),{seq,code,fixes}=plan;
  this.state.fixes[d.id]={day:fixes.day,n:fixes.n+1,lastSeq:seq,lastResult:result.ok?'repaired':result.code};
  this.save();
  const record={agent:AGENT,at:this.now(),device:d.id,self_fix:code,ok:result.ok,result:result.code||'ready',fixes_today:fixes.n+1};
  this.append('digests.jsonl',JSON.stringify(record)+'\n');
  this.journal(`자가 수정 ${result.ok?'성공':'실패'} · ${d.id}`,`- 원인 ${code}, 휴식 후 connection repair 호출\n- 결과 ${record.result}, 오늘 ${record.fixes_today}/${FIX_PER_DAY}회`);
  return result.ok;
 }

 // ---- cycle ----
 async alerts(now){
  const day=localDay(now),wanted={};
  for(const d of this.db.prepare("SELECT id,health,quarantined,faults FROM devices WHERE kind='android'").all()){
   const codes=[];
   if(d.health==='unavailable'&&!d.quarantined){
    let faults={};try{faults=JSON.parse(d.faults||'{}');}catch{}
    const plan=Object.keys(faults).length?{alert:'PHONE_NEEDS_REPAIR:'+Object.values(faults)[0]}:this.fixPlan(d,now);
    if(plan.alert)codes.push(plan.alert);
    else if(plan.fix&&!await this.selfFix(d,plan.fix))codes.push('SELF_FIX_FAILED:'+plan.fix.code);
   }
   const p=this.has('device_pacing')?this.db.prepare('SELECT stopped_day,reason FROM device_pacing WHERE device_id=?').get(d.id):null;
   if(p&&p.stopped_day===day)codes.push('PACING_STOPPED:'+(p.reason||'UNKNOWN'));
   const w=this.has('phone_warmup')?this.db.prepare("SELECT state,error FROM phone_warmup WHERE device_id=? AND day=?").get(d.id,day):null;
   if(w?.state==='failed')codes.push('WARMUP_FAILED:'+(w.error||'UNKNOWN'));
   if(codes.length)wanted[d.id]=codes.join(',');
  }
  for(const [id,value] of Object.entries(wanted)){
   if(this.state.alerts[id]===value)continue;
   if(await this.feishu(`Crawler watcher alert (person needed): ${id}: ${value}`,{all:true}))this.state.alerts[id]=value;
  }
  for(const id of Object.keys(this.state.alerts))if(!wanted[id])delete this.state.alerts[id];
 }
 async incidents(now){
  const attempts=this.attemptsSince(this.state.cursor),found=[];
  for(const a of attempts){
   this.state.cursor=Math.max(this.state.cursor,a.seq);this.save();
   const code=a.error?JSON.parse(a.error).code:null;
   this.append('digests.jsonl',JSON.stringify({agent:AGENT,at:a.finished,device:a.device_id,op:a.op,secs:Math.round((a.finished-a.started)/1000),state:a.state,code})+'\n');
   if(code&&DETECTION.has(code))found.push({at:a.finished,device:a.device_id,code,op:a.op});
  }
  for(const e of this.newIncidentsFromLog())if(e.kind==='ui_blocked')found.push({at:e.at,device:e.device_id,code:'UI_BLOCKED',overlay:e.overlay,labels:e.labels});
  else this.append('digests.jsonl',JSON.stringify({agent:AGENT,at:e.at,device:e.device_id,dialog:e.dialog})+'\n');
  for(const incident of found){
   const seq=this.sequence(incident.device,incident.at);
   const record={agent:AGENT,...incident,sequence:seq};
   const answer=await this.ask(
    '你是小红书采集节奏审查员。只根据给出的证据判断，不要臆测。用韩语回答，简短。输出: 1) 가장 의심되는 트리거(직전 순서 중 무엇) 2) 근거 3) 확신도(낮음/중간/높음) 4) 다음에 바꿔볼 수치 하나.',
    JSON.stringify(record));
   record.analysis=answer;
   this.append('incidents.jsonl',JSON.stringify(record)+'\n');
   this.journal(`탐지 ${incident.code} · ${incident.device} · ${incident.op||''}`,
    `- 직전 30분: 작업 ${seq.items.length}건, 작업 간격(초) ${JSON.stringify(seq.gaps_s.slice(-10))}, 입력 ${JSON.stringify(seq.input_counts)}\n`+
    (incident.overlay?`- 오버레이: ${incident.overlay}\n`:'')+`\n${answer||'(로컬 모델 응답 없음: 증거만 기록)'}`);
  }
 }
 dayStats(from,to){
  const rows=this.db.prepare(`SELECT a.device_id,a.state,a.error FROM attempts a WHERE a.finished BETWEEN ? AND ?`).all(from,to);
  const by={};for(const r of rows){const d=by[r.device_id]||(by[r.device_id]={items:0,ok:0,codes:{}});d.items++;if(r.state==='succeeded')d.ok++;const c=r.error?JSON.parse(r.error).code:null;if(c)d.codes[c]=(d.codes[c]||0)+1;}
  const brakes=this.db.prepare("SELECT count(*) n FROM events WHERE type='device.pacing_brake' AND created BETWEEN ? AND ?").get(from,to).n;
  let incidents=[];try{incidents=fs.readFileSync(path.join(this.dir,'incidents.jsonl'),'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(i=>i.at>=from&&i.at<=to);}catch{}
  return {devices:by,brakes,incidents:incidents.map(i=>({at:stamp(i.at),device:i.device,code:i.code,analysis:i.analysis}))};
 }
 async summaries(now){
  const day=localDay(now),key=String(day);
  const local=now-day;
  if(local>=23.5*HOUR&&!this.state.summaries[key]){
   const stats=this.dayStats(day,now);
   // Feishu is read by partners: summaries and reports go out in English.
   const answer=await this.ask('You review Xiaohongshu crawler pacing. Write today\'s summary in English, at most 5 lines: throughput, detections/brakes, suspicious patterns, what to check tomorrow. Use only the evidence given.',JSON.stringify(stats));
   const text=`Crawler watcher daily summary (${stamp(now).slice(0,10)})\n`+Object.entries(stats.devices).map(([d,s])=>`- ${d}: ${s.items} items, ${s.ok} succeeded, errors ${JSON.stringify(s.codes)}`).join('\n')+`\n- Brakes ${stats.brakes}, detections ${stats.incidents.length}\n\n${answer||''}`;
   this.journal('일일 요약',text);await this.feishu(text);
   this.state.summaries[key]=true;
  }
  for(const checkpoint of [2,7]){
   const due=this.state.startedAt+checkpoint*DAY,flag='report'+checkpoint;
   if(now>=due&&!this.state.summaries[flag]){
    const stats=this.dayStats(this.state.startedAt,now);
    const answer=await this.ask('You review Xiaohongshu crawler pacing. Write a report in English: which sequence/number combinations preceded detections, the ranges that stayed safe, and up to 5 values in config/pacing.json human_v1 to change, with reasons. Make no claim without evidence.',JSON.stringify(stats));
    const text=`Crawler watcher day-${checkpoint} report\n- Items in period: ${Object.entries(stats.devices).map(([d,s])=>`${d} ${s.items}`).join(', ')}\n- Brakes ${stats.brakes}, detections ${stats.incidents.length}\n\n${answer||'(no local model answer)'}`;
    this.journal(`${checkpoint}일차 보고`,text);await this.feishu(text);
    this.state.summaries[flag]=true;
   }
  }
 }
 async cycle(){
  const now=this.now();
  // Save after each step so a stop never repeats a delivered alert or report.
  await this.alerts(now);this.save();
  await this.incidents(now);this.save();
  await this.summaries(now);this.save();
  if(this.planner){await this.planner.cycle(now);this.save();}
  this.state.lastCycle=now;this.save();
  // One small status file per watcher, the same shape for every agent.
  const day=localDay(now);
  const status={agent:AGENT,at:now,until:Number.isFinite(this.until)?this.until:null,open_alerts:this.state.alerts,
   self_fixes_today:Object.fromEntries(Object.entries(this.state.fixes).filter(([,f])=>f.day===day).map(([id,f])=>[id,f.n])),
   llm_calls_last_hour:this.state.llm.filter(t=>t>now-HOUR).length,rss_mb:Math.round(process.memoryUsage().rss/1048576)};
  fs.writeFileSync(path.join(this.dir,'status.json.tmp'),JSON.stringify(status));fs.renameSync(path.join(this.dir,'status.json.tmp'),path.join(this.dir,'status.json'));
 }
 async run({onError=()=>{}}={}){
  this.journal('watcher 시작',`종료 ${Number.isFinite(this.until)?stamp(this.until):'없음(상시)'}, 주기 ${Math.round(this.intervalMs/MIN)}분, 모델 ${this.llmSource()?.model||'없음(증거만 기록)'}`);this.save();
  while(this.now()<this.until){
   try{await this.cycle();}catch(error){onError(error);}
   // Alerts and incidents are checked every 5 minutes; heavier work is throttled by state.
   await new Promise(resolve=>setTimeout(resolve,Math.min(this.intervalMs,Math.max(1000,this.until-this.now()))));
  }
  this.journal('watcher 종료','기간 만료');this.save();
 }
}

if(require.main===module){
 const runtime=path.resolve(process.env.CRAWLER_RUNTIME_DIR||'runtime');
 const analysisRoot=path.resolve(process.env.XHS_ANALYSIS_ROOT||path.join(process.env.HOME||'.','Development','xhs-analysis'));
 const until=process.env.WATCHER_UNTIL?Date.parse(process.env.WATCHER_UNTIL):Infinity;
 if(Number.isNaN(until)){process.stderr.write('WATCHER_UNTIL must be an ISO time when set\n');process.exit(2);}
 const watcher=new Watcher({runtime,analysisRoot,until});
 // WATCHER_PLAN=0 turns the daily activity plan off.
 if(process.env.WATCHER_PLAN!=='0')watcher.planner=new (require('./planner').Planner)(watcher);
 watcher.run({onError:e=>process.stderr.write('[watcher] '+(e.code||e.message)+'\n')})
  .then(()=>process.exit(0),e=>{process.stderr.write(String(e)+'\n');process.exit(1);});
}
module.exports={Watcher,DETECTION,SELF_FIX};
