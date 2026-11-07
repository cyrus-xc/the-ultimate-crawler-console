'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../service/store'),{LocalWorker}=require('../service/worker'),{resumePlan}=require('../service/resume');
const input={schema_version:'crawler.request.v1',idempotency_key:'one',platform:'xiaohongshu',operation:'profile.posts',targets:[{user_id:'u'}]};
function setup(t){const store=new Store();t.after(()=>store.close());store.register({id:'p',serial:'s',kind:'android',capabilities:[{platform:'xiaohongshu',operation:'profile.posts'}]});return store;}
test('adapter receives safe resume mode and commits response observations',async t=>{
  const s=setup(t),r=s.submit(input);const worker=new LocalWorker(s,new Map([['p',{version:'1',execute:async({claim,resume,input,commit})=>{
    assert.equal(resume.mode,'start');await input(async()=>{});commit({items:[{key:'post',value:{body:'from response'}}],checkpoint:{binding:resume.binding,cursor:'next',device_id:claim.device_id,adapter_version:'1',seen_ids:['post']}});
  }}]]));assert.equal(worker.dispatch(),1);await Promise.all(worker.active.values());assert.equal(s.request(r.id).state,'succeeded');assert.equal(s.results(r.id).length,1);
});
test('same device resumes cursor, cross device retains seen IDs but discards cursor',t=>{
  const s=setup(t);s.submit(input);const c=s.claim(),initial=resumePlan(c,'1');c.checkpoint={binding:initial.binding,cursor:'opaque',device_id:'p',adapter_version:'1',seen_ids:['n']};
  assert.equal(resumePlan(c,'1').cursor,'opaque');const next=resumePlan({...c,device_id:'other'},'1');assert.equal(next.mode,'replay_deduplicate');assert.equal(next.cursor,null);assert.deepEqual(next.seen_ids,['n']);
  assert.throws(()=>resumePlan({...c,target:{user_id:'other'}},'1'),{code:'CHECKPOINT_MISMATCH'});
});
test('cancellation aborts adapter before device lock is released',async t=>{
  const s=setup(t),r=s.submit(input);let interrupted=false;
  const worker=new LocalWorker(s,new Map([['p',{version:'1',execute:async({signal})=>await new Promise((resolve,reject)=>{
    signal.addEventListener('abort',()=>{interrupted=true;reject(signal.reason);},{once:true});
  })}]]),{heartbeatMs:2});worker.dispatch();s.transition(r.id,'cancel');assert.equal(s.devices()[0].owner,r.id);
  await Promise.all(worker.active.values());assert.ok(interrupted);assert.equal(s.request(r.id).state,'cancelled');assert.equal(s.devices()[0].owner,null);
});

test('manual continuation waits for pipeline decision before next action',async t=>{
 const s=setup(t),r=s.submit({...input,continuation:{mode:'manual'}});let completed=false;
 const worker=new LocalWorker(s,new Map([['p',{version:'1',execute:async({commit,waitForDecision})=>{commit({checkpoint:{page:1},items:[{key:'n',value:{body:'evidence'}}]});assert.equal(await waitForDecision(),'stop');completed=true;}}]]),{heartbeatMs:2});
 worker.dispatch();const d=s.request(r.id).decisions[0];assert.ok(d);assert.equal(completed,false);s.decide(r.id,d.id,'stop');await Promise.all(worker.active.values());assert.ok(completed);assert.equal(s.request(r.id).state,'succeeded');
});

test('manual mode fences inputs even when adapter forgets decision handshake',async t=>{
 const s=setup(t),r=s.submit({...input,continuation:{mode:'manual'}});let touched=false;
 const worker=new LocalWorker(s,new Map([['p',{version:'1',execute:async({commit,input})=>{
  commit({checkpoint:{page:1}});await input(()=>{touched=true;});
 }}]]));worker.dispatch();await Promise.all(worker.active.values());
 assert.equal(touched,false);assert.equal(s.request(r.id).units[0].error.code,'BUSINESS_DECISION_REQUIRED');
});
test('stop decision prevents subsequent adapter input',async t=>{
 const s=setup(t),r=s.submit({...input,continuation:{mode:'manual'}});let touched=false;
 const worker=new LocalWorker(s,new Map([['p',{version:'1',execute:async({commit,waitForDecision,input})=>{
  commit({checkpoint:{page:1}});await waitForDecision();await input(()=>{touched=true;});
 }}]]));worker.dispatch();s.decide(r.id,s.request(r.id).decisions[0].id,'stop');
 await Promise.all(worker.active.values());assert.equal(touched,false);assert.equal(s.request(r.id).units[0].error.code,'BUSINESS_STOPPED');
});

test('replacement device waits on saved business decision before touching hardware',async t=>{
 const s=setup(t);s.register({id:'p2',serial:'s2',kind:'android',capabilities:[{platform:'xiaohongshu',operation:'profile.posts'}]});
 const r=s.submit({...input,continuation:{mode:'manual'}}),claim=s.claim(),resume=resumePlan(claim,'1');
 s.commit(claim,{checkpoint:{binding:resume.binding,device_id:'p',adapter_version:'1',cursor:'next',seen_ids:['n']}});
 const d=s.requestDecision(claim);s.fail(claim,{code:'DISCONNECTED',scope:'device'});
 let touched=false;const worker=new LocalWorker(s,new Map([['p2',{version:'1',execute:async()=>{touched=true;}}]]));
 worker.dispatch();assert.equal(touched,false);s.decide(r.id,d.id,'stop');await Promise.all(worker.active.values());
 assert.equal(touched,false);assert.equal(s.request(r.id).state,'succeeded');
});
test('worker passes share selection to adapter without treating false as stop',async t=>{
 const s=setup(t),r=s.submit({...input,continuation:{mode:'manual'}});let afterDecision=false;
 const worker=new LocalWorker(s,new Map([['p',{version:'1',execute:async({commit,waitForDecision,input})=>{
  commit({checkpoint:{decision:{phase:'detail_ready',subject_id:'n1'}}});
  assert.deepEqual(await waitForDecision(),{action:'continue',capture_share:false,phase:'detail_ready',subject_id:'n1'});
  await input(()=>{afterDecision=true;});
 }}]]));worker.dispatch();s.decide(r.id,s.request(r.id).decisions[0].id,'continue',false);
 await Promise.all(worker.active.values());assert.equal(afterDecision,true);assert.equal(s.request(r.id).state,'succeeded');
});
