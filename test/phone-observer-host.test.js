'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');const {PassThrough,Writable}=require('node:stream');
const {ObserverHost}=require('../adapters/xhs-phone/capture');
const {PhoneRuntime}=require('../adapters/xhs-phone/runtime');
const {XhsNavigation}=require('../adapters/xhs-phone/navigation');

// A fake observer_host.py: one process serves sequential captures.
function hostFixture({start={event:'host_ready'},reply=(_m,phase)=>phase==='action'?{event:'result',result:{operation:'search',status:200,response:{data:1},request:{path:'/s'}}}:null}={}){
 const spawned=[];
 const spawnProcess=(_python,args)=>{
  const child=new EventEmitter();child.args=args;child.stdout=new PassThrough();child.killed=false;let pending=null;
  const out=v=>setImmediate(()=>child.stdout.write(JSON.stringify(v)+'\n'));
  child.kill=()=>{if(!child.killed){child.killed=true;setImmediate(()=>child.emit('close',null));}return true;};
  child.stdin=new Writable({write(data,_e,callback){
   for(const line of String(data).split('\n').filter(Boolean)){
    const message=JSON.parse(line);
    if(message.operation){pending=message;const early=reply(message,'request');if(early)out(early);else out({event:'perform_action'});}
    else if(message.action){const done=reply(pending,'action');if(done)out(done);}
   }
   callback();
  }});
  spawned.push(child);out(start);return child;
 };
 const host=new ObserverHost({python:'py',contractPath:'c.json',spawnProcess,startTimeoutMs:500});
 const options={endpoint:'127.0.0.1:1234',pid:123,operation:'search',values:{},guard:()=>{},trigger:async()=>{}};
 return {host,spawned,options};
}

test('one observer process serves sequential captures for the same App pid',async()=>{
 const {host,spawned,options}=hostFixture();
 for(let i=0;i<3;i++)assert.equal((await host.capture(options)).response.data,1);
 assert.equal(spawned.length,1);assert.ok(spawned[0].args.some(a=>a.endsWith('observer_host.py')));
 assert.equal(spawned[0].killed,false);
 await host.close();assert.equal(spawned[0].killed,true);
});

test('a new App pid replaces the observer process',async()=>{
 const {host,spawned,options}=hostFixture();
 await host.capture(options);await host.capture({...options,pid:456});
 assert.equal(spawned.length,2);assert.equal(spawned[0].killed,true);assert.equal(spawned[1].killed,false);
});

test('an ordinary capture error before the action keeps the observer attached',async()=>{
 let first=true;
 const {host,spawned,options}=hostFixture({reply:(_m,phase)=>{if(phase==='request'&&first){first=false;return {event:'error',code:'CAPTURE_OBSERVER_TIMEOUT',diagnostics:{stage:'capture'}};}return phase==='action'?{event:'result',result:{operation:'search',status:200,response:{data:2},request:{}}}:null;}});
 await assert.rejects(host.capture(options),{code:'CAPTURE_OBSERVER_TIMEOUT'});
 assert.equal((await host.capture(options)).response.data,2);assert.equal(spawned.length,1);
});

test('a failed trigger replaces the observer, whose state is then unknown',async()=>{
 const {host,spawned,options}=hostFixture();
 await assert.rejects(host.capture({...options,trigger:async()=>{throw Object.assign(Error('x'),{code:'UI_BLOCKED_BY_OVERLAY'});}}),{code:'UI_BLOCKED_BY_OVERLAY'});
 assert.equal(spawned[0].killed,true);await host.capture(options);assert.equal(spawned.length,2);
});

test('an unobserved page is reported back and the observer stays attached',async()=>{
 const {host,spawned,options}=hostFixture({reply:(m,phase)=>phase==='action'?{event:'error',code:'PHONE_PAGE_RESPONSE_UNOBSERVED',diagnostics:{events:{observer_ready:1}}}:null});
 await assert.rejects(host.capture({...options,trigger:async()=>{throw Object.assign(Error('x'),{code:'PHONE_PAGE_RESPONSE_UNOBSERVED'});}}),e=>e.code==='PHONE_PAGE_RESPONSE_UNOBSERVED'&&e.diagnostics.events.observer_ready===1);
 assert.equal(spawned[0].killed,false);
});

test('a detached App session replaces the observer',async()=>{
 const {host,spawned,options}=hostFixture({reply:(_m,phase)=>phase==='action'?{event:'error',code:'OBSERVER_DETACHED',diagnostics:{stage:'host'}}:null});
 await assert.rejects(host.capture(options),{code:'OBSERVER_DETACHED'});
 assert.equal(spawned[0].killed,true);assert.equal(host.alive(options.endpoint,options.pid),false);
});

test('attachment failure keeps the stage the consumer uses for its one restart',async()=>{
 const {host,options}=hostFixture({start:{event:'error',code:'CAPTURE_FAILED',diagnostics:{exception_type:'ProcessNotFoundError',stage:'attachment'}}});
 let inputs=0;
 await assert.rejects(host.capture({...options,trigger:async()=>{inputs++;}}),e=>e.code==='CAPTURE_FAILED'&&e.diagnostics.stage==='attachment'&&e.diagnostics.exception_type==='ProcessNotFoundError');
 assert.equal(inputs,0);
});

test('a stop request during the action replaces the observer',async()=>{
 const {host,spawned,options}=hostFixture();const controller=new AbortController();
 const running=host.capture({...options,signal:controller.signal,trigger:()=>new Promise(resolve=>{setImmediate(()=>{controller.abort(Object.assign(Error('stop'),{code:'STOP_REQUESTED'}));resolve();});})});
 await assert.rejects(running,{code:'STOP_REQUESTED'});assert.equal(spawned[0].killed,true);
});

test('kept runtime state leaves forward and server for the next unit',async()=>{
 const commands=[];const adb={serial:'S',command:async a=>{commands.push(a);return '';},wait:async()=>{}};
 const state={forward:41000,ownedServer:{pid:'900',start:'1'}};
 const contract={package:'com.xingin.xhs',version:'9.56.0'};
 const runtime=new PhoneRuntime(adb,{binary:__filename,sha256:'0'.repeat(64),contract,state});
 await runtime.close({keep:true});
 assert.deepEqual(commands,[]);
 const next=new PhoneRuntime(adb,{binary:__filename,sha256:'0'.repeat(64),contract,state});
 assert.equal(next.forward,41000);assert.deepEqual(next.ownedServer,{pid:'900',start:'1'});
});

const n=(text,extra={})=>({text,class:'android.widget.TextView',package:'com.xingin.xhs',center:[50,900],width:100,height:40,...extra});
const screen=[n('',{center:[540,1170],width:1080,height:2340})];
test('a note without comments is never tapped into the composer',async()=>{
 for(const view of [[n('评论 0')],[n('评论'),n('还没有评论哦')],[n('抢首评'),n('评论')]]){
  const taps=[];const adb={ui:async()=>[...screen,...view],tap:async node=>taps.push(node.text),shell:async()=>{},swipe:async()=>{},wait:async()=>{}};
  const nav=new XhsNavigation(adb,{guard:()=>{},random:()=>.5});
  assert.equal(await nav.comments(),false);assert.deepEqual(taps,[]);
 }
});

test('an opened comment composer is closed without typing and recorded',async()=>{
 const views=[[...screen,n('评论 3')],[...screen,n('',{class:'android.widget.EditText',focused:'true'})]];
 const commands=[],incidents=[];
 const adb={ui:async()=>views.shift()||screen,tap:async node=>commands.push(['tap',node.text]),shell:async(...a)=>commands.push(a),wait:async()=>{},logIncident:e=>incidents.push(e.kind)};
 const nav=new XhsNavigation(adb,{guard:()=>{}});
 assert.equal(await nav.comments(),false);
 assert.deepEqual(commands,[['tap','评论 3'],['input','keyevent','4']]);assert.deepEqual(incidents,['comment_composer_closed']);
});
