'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../service/store');
const {Watcher}=require('../tools/watcher/watcher');
const {createInputLog}=require('../service/input_log');

function input(extra={}){return {schema_version:'crawler.request.v1',idempotency_key:'w1',platform:'xiaohongshu',operation:'post.detail',effort:'full',targets:[{post_id:'n1'}],...extra};}
function setup(t,{local=true}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'watcher-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const runtime=path.join(dir,'runtime'),analysis=path.join(dir,'analysis');
 fs.mkdirSync(runtime,{recursive:true});fs.mkdirSync(path.join(analysis,'runtime'),{recursive:true});fs.mkdirSync(path.join(analysis,'core','llm'),{recursive:true});
 fs.writeFileSync(path.join(analysis,'runtime','llm-settings.json'),JSON.stringify({pipeline:'x',agent:'x'}));
 fs.writeFileSync(path.join(analysis,'core','llm','sources.json'),JSON.stringify({x:{provider:local?'local':'deepseek',model:'M',base_url:'http://127.0.0.1:18190'}}));
 fs.writeFileSync(path.join(analysis,'.env'),'FEISHU_APP_ID=app\nPIPELINE_AGENT_APP_SECRET=secret\nFEISHU_CHAT_ID=chat\n');
 let now=Date.UTC(2026,10,27,8);
 const store=new Store(path.join(runtime,'queue.db'),{now:()=>now});
 store.register({id:'android:p',kind:'android',serial:'p',capabilities:[{platform:'xiaohongshu',operation:'post.detail'}]});
 const calls=[];
 const fetchImpl=async(url,options)=>{const body=JSON.parse(options.body||'{}');calls.push({url,body});
  const json=url.includes('tenant_access_token')?{tenant_access_token:'t'}:url.includes('chat/completions')?{choices:[{message:{content:'트리거: 연속 상세 열기'}}]}:{code:0};
  return {ok:true,json:async()=>json};};
 return {runtime,analysis,store,calls,fetchImpl,at:v=>{now=v;},now:()=>now};
}

test('a detection is journaled with its preceding sequence and analysed only by a local model',async t=>{
 const f=setup(t);
 const log=createInputLog(path.join(f.runtime,'input-log'),{now:f.now});
 log('android:p',{kind:'swipe',values:[1,2,3,4,400]});
 f.store.submit(input());const claim=f.store.claim();
 f.at(f.now()+20000);f.store.fail(claim,{code:'XHS_ACCESS_RESTRICTED',scope:'platform'});
 const w=new Watcher({runtime:f.runtime,analysisRoot:f.analysis,until:f.now()+1,now:f.now,fetchImpl:f.fetchImpl});
 await w.cycle();
 const incident=JSON.parse(fs.readFileSync(path.join(f.runtime,'watcher','incidents.jsonl'),'utf8').trim());
 assert.equal(incident.code,'XHS_ACCESS_RESTRICTED');assert.equal(incident.sequence.items.length,1);
 assert.equal(incident.sequence.input_counts.swipe,1);assert.match(incident.analysis,/트리거/);
 const llm=f.calls.find(c=>c.url.includes('chat/completions'));
 assert.equal(llm.url,'http://127.0.0.1:18190/v1/chat/completions');assert.equal(llm.body.model,'M');
 assert.match(fs.readFileSync(path.join(f.runtime,'watcher','journal.md'),'utf8'),/XHS_ACCESS_RESTRICTED/);
 await w.cycle();
 assert.equal(fs.readFileSync(path.join(f.runtime,'watcher','incidents.jsonl'),'utf8').trim().split('\n').length,1,'cursor prevents repeats');
});

test('a metered model is never called; evidence is still recorded',async t=>{
 const f=setup(t,{local:false});
 f.store.submit(input());const claim=f.store.claim();f.store.fail(claim,{code:'VERIFICATION_REQUIRED',scope:'platform'});
 const w=new Watcher({runtime:f.runtime,analysisRoot:f.analysis,until:f.now()+1,now:f.now,fetchImpl:f.fetchImpl});
 await w.cycle();
 assert.ok(!f.calls.some(c=>c.url.includes('chat/completions')));
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.runtime,'watcher','incidents.jsonl'),'utf8').trim()).analysis,null);
});

test('a phone needing repair alerts once with @All and the database stays untouched',async t=>{
 const f=setup(t);
 f.store.db.prepare("UPDATE devices SET health='unavailable' WHERE id='android:p'").run();
 const before=fs.statSync(path.join(f.runtime,'queue.db')).mtimeMs;
 const w=new Watcher({runtime:f.runtime,analysisRoot:f.analysis,until:f.now()+1,now:f.now,fetchImpl:f.fetchImpl});
 await w.cycle();await w.cycle();
 const sent=f.calls.filter(c=>c.url.includes('/im/v1/messages'));
 assert.equal(sent.length,1);assert.match(JSON.parse(sent[0].body.content).text,/<at user_id="all">.*PHONE_NEEDS_REPAIR/s);
 assert.throws(()=>w.db.prepare("UPDATE devices SET health='ready'").run());
 assert.equal(fs.statSync(path.join(f.runtime,'queue.db')).mtimeMs,before);
});

test('daily summary goes out once after 23:30 without @',async t=>{
 const f=setup(t);
 const day=Math.floor((f.now()+8*3600000)/86400000)*86400000-8*3600000;
 f.at(day+23.6*3600000);
 const w=new Watcher({runtime:f.runtime,analysisRoot:f.analysis,until:f.now()+1,now:f.now,fetchImpl:f.fetchImpl});
 await w.cycle();await w.cycle();
 const sent=f.calls.filter(c=>c.url.includes('/im/v1/messages'));
 assert.equal(sent.length,1);const text=JSON.parse(sent[0].body.content).text;
 assert.match(text,/일일 요약/);assert.ok(!text.includes('<at'));
});
