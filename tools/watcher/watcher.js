'use strict';
// Crawler watcher for the first week of human-like pacing. Read-only: it never
// changes settings, devices or requests. Every cycle it digests queue results,
// pacing and input evidence; on a detection signal it asks the local LLM
// (never a paid API) which preceding sequence most likely triggered it and
// journals the answer. It sends a daily summary and day-2/day-7 reports to
// Feishu without @, and person-needed alerts with @All. It exits at WATCHER_UNTIL.
const fs=require('node:fs'),path=require('node:path');
const Database=require('better-sqlite3');

const MIN=60000,HOUR=60*MIN,DAY=24*HOUR,OFFSET=8*HOUR;
const localDay=ms=>Math.floor((ms+OFFSET)/DAY)*DAY-OFFSET;
const stamp=ms=>new Date(ms+OFFSET).toISOString().slice(0,16).replace('T',' ');
const DETECTION=new Set(['VERIFICATION_REQUIRED','CRAWLER_VERIFICATION_REQUIRED','LOGIN_OR_VERIFICATION_REQUIRED','LOGIN_REQUIRED',
 'XHS_ACCESS_RESTRICTED','CRAWLER_ACCESS_RESTRICTED','ACCESS_RESTRICTED','UI_BLOCKED_BY_OVERLAY','PHONE_CAPTCHA']);

function readEnv(file){
 const env={};try{for(const line of fs.readFileSync(file,'utf8').split('\n')){const m=line.match(/^([A-Z0-9_]+)=(.*)$/);if(m)env[m[1]]=m[2].trim().replace(/^"|"$/g,'');}}catch{}
 return env;
}

class Watcher {
 constructor({runtime,analysisRoot,until,intervalMs=5*MIN,now=Date.now,fetchImpl=fetch,startedAt}){
  Object.assign(this,{runtime,analysisRoot,until,intervalMs,now,fetchImpl});
  this.dir=path.join(runtime,'watcher');fs.mkdirSync(this.dir,{recursive:true,mode:0o700});
  this.stateFile=path.join(this.dir,'state.json');
  this.state={cursor:0,eventCursor:0,inputOffsets:{},alerts:{},summaries:{},startedAt:startedAt||now(),...this.load()};
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
 async ask(system,user){
  const source=this.llmSource();if(!source)return null;
  try{
   const res=await this.fetchImpl(source.base_url.replace(/\/$/,'')+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({model:source.model,temperature:0.2,max_tokens:1200,reasoning_effort:'low',messages:[{role:'system',content:system},{role:'user',content:user}]}),
    signal:AbortSignal.timeout(300000)});
   if(!res.ok)return null;const body=await res.json();
   return String(body.choices?.[0]?.message?.content||'').trim()||null;
  }catch{return null;}
 }

 // ---- Feishu ----
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

 // ---- cycle ----
 async alerts(now){
  const day=localDay(now),wanted={};
  for(const d of this.db.prepare("SELECT id,health,quarantined FROM devices WHERE kind='android'").all()){
   const codes=[];
   if(d.health==='unavailable'&&!d.quarantined)codes.push('PHONE_NEEDS_REPAIR');
   const p=this.has('device_pacing')?this.db.prepare('SELECT stopped_day,reason FROM device_pacing WHERE device_id=?').get(d.id):null;
   if(p&&p.stopped_day===day)codes.push('PACING_STOPPED:'+(p.reason||'UNKNOWN'));
   const w=this.has('phone_warmup')?this.db.prepare("SELECT state,error FROM phone_warmup WHERE device_id=? AND day=?").get(d.id,day):null;
   if(w?.state==='failed')codes.push('WARMUP_FAILED:'+(w.error||'UNKNOWN'));
   if(codes.length)wanted[d.id]=codes.join(',');
  }
  for(const [id,value] of Object.entries(wanted)){
   if(this.state.alerts[id]===value)continue;
   if(await this.feishu(`Crawler watcher: ${id}: ${value}`,{all:true}))this.state.alerts[id]=value;
  }
  for(const id of Object.keys(this.state.alerts))if(!wanted[id])delete this.state.alerts[id];
 }
 async incidents(now){
  const attempts=this.attemptsSince(this.state.cursor),found=[];
  for(const a of attempts){
   this.state.cursor=Math.max(this.state.cursor,a.seq);this.save();
   const code=a.error?JSON.parse(a.error).code:null;
   this.append('digests.jsonl',JSON.stringify({at:a.finished,device:a.device_id,op:a.op,secs:Math.round((a.finished-a.started)/1000),state:a.state,code})+'\n');
   if(code&&DETECTION.has(code))found.push({at:a.finished,device:a.device_id,code,op:a.op});
  }
  for(const e of this.newIncidentsFromLog())if(e.kind==='ui_blocked')found.push({at:e.at,device:e.device_id,code:'UI_BLOCKED',overlay:e.overlay,labels:e.labels});
  else this.append('digests.jsonl',JSON.stringify({at:e.at,device:e.device_id,dialog:e.dialog})+'\n');
  for(const incident of found){
   const seq=this.sequence(incident.device,incident.at);
   const record={...incident,sequence:seq};
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
   const answer=await this.ask('你是小红书采集节奏审查员。用韩语写当日总结，5行以内：처리량, 탐지/브레이크, 의심 패턴, 내일 확인할 것.',JSON.stringify(stats));
   const text=`크롤러 watcher 일일 요약 (${stamp(now).slice(0,10)})\n`+Object.entries(stats.devices).map(([d,s])=>`- ${d}: ${s.items}건, 성공 ${s.ok}, 오류 ${JSON.stringify(s.codes)}`).join('\n')+`\n- 브레이크 ${stats.brakes}회, 탐지 ${stats.incidents.length}건\n\n${answer||''}`;
   this.journal('일일 요약',text);await this.feishu(text);
   this.state.summaries[key]=true;
  }
  for(const checkpoint of [2,7]){
   const due=this.state.startedAt+checkpoint*DAY,flag='report'+checkpoint;
   if(now>=due&&!this.state.summaries[flag]){
    const stats=this.dayStats(this.state.startedAt,now);
    const answer=await this.ask('你是小红书采集节奏审查员。用韩语写报告：어떤 순서/수치 조합에서 탐지가 났는지, 안전했던 범위, config/pacing.json 의 human_v1 에서 바꿀 값과 이유(최대 5개). 증거 없는 주장은 하지 마.',JSON.stringify(stats));
    const text=`크롤러 watcher ${checkpoint}일차 보고\n- 기간 처리: ${Object.entries(stats.devices).map(([d,s])=>`${d} ${s.items}건`).join(', ')}\n- 브레이크 ${stats.brakes}회, 탐지 ${stats.incidents.length}건\n\n${answer||'(로컬 모델 응답 없음)'}`;
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
  await this.summaries(now);
  this.state.lastCycle=now;this.save();
 }
 async run({onError=()=>{}}={}){
  this.journal('watcher 시작',`종료 예정 ${stamp(this.until)}, 주기 ${Math.round(this.intervalMs/MIN)}분, 모델 ${this.llmSource()?.model||'없음(증거만 기록)'}`);this.save();
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
 const until=Date.parse(process.env.WATCHER_UNTIL||'');
 if(!Number.isFinite(until)){process.stderr.write('WATCHER_UNTIL required (ISO time)\n');process.exit(2);}
 new Watcher({runtime,analysisRoot,until}).run({onError:e=>process.stderr.write('[watcher] '+(e.code||e.message)+'\n')})
  .then(()=>process.exit(0),e=>{process.stderr.write(String(e)+'\n');process.exit(1);});
}
module.exports={Watcher,DETECTION};
