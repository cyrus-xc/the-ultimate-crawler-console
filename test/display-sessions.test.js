const test=require('node:test'),assert=require('node:assert/strict');
const {PassThrough}=require('node:stream');const {EventEmitter}=require('node:events');
const {DisplaySessions}=require('../service/display_sessions');
const store={devices:()=>[{id:'android:a',kind:'android',serial:'a'}]};
const meta=Buffer.from('683236340000043800000920','hex');
const packet=(flag,text)=>{const data=Buffer.from(text),header=Buffer.alloc(12);header[0]=flag;header.writeUInt32BE(data.length,8);return Buffer.concat([header,data]);};
class Response extends EventEmitter{constructor(){super();this.data=[];this.writableLength=0;}setHeader(){assert.ok(!this.headersSent);}write(b){this.headersSent=true;this.data.push(b);return true;}destroy(){if(this.destroyed)return;this.destroyed=true;this.emit('close');}}
function setup(t){let starts=0,closes=0;const source=new PassThrough();const display=new DisplaySessions(store,{start:async(serial)=>{assert.equal(serial,'a');starts++;return {stream:source,close:async()=>{closes++;source.destroy();}};}});t.after(()=>display.close());return {display,source,counts:()=>({starts,closes})};}
test('explicit video viewers share an encoder; late join receives config and waits for key frame',async t=>{
 const {display,source,counts}=setup(t),a=display.open('android:a','a'),b=display.open('android:a','a');assert.equal(counts().starts,0);
 await assert.rejects(display.stream(a.id,'other',new Response()),{code:'DISPLAY_EXPIRED'});
 const r1=new Response();await display.stream(a.id,'a',r1);
 const first=Buffer.concat([meta,packet(128,'config'),packet(64,'key')]);for(const byte of first)source.write(Buffer.from([byte]));assert.equal(r1.data.length,3);
 const r2=new Response();await display.stream(b.id,'a',r2);source.write(packet(0,'delta'));assert.equal(r2.data.length,1);
 source.write(packet(64,'next'));assert.equal(r2.data.length,3);assert.equal(counts().starts,1);
 display.stop(a.id,'a');assert.equal(counts().closes,0);r2.destroy();await display.close();assert.equal(counts().closes,1);
});
test('invalid packet ends all viewers and drains encoder',async t=>{
 const {display,source,counts}=setup(t),a=display.open('android:a','a'),r=new Response();await display.stream(a.id,'a',r);
 const invalid=Buffer.alloc(12);invalid.writeUInt32BE(20*1024*1024,8);source.write(Buffer.concat([meta,invalid]));await display.close();assert.equal(r.destroyed,true);assert.equal(counts().closes,1);
});
test('abandoned unopened sessions expire; heartbeat extends attached sessions but abandoned streams expire',async t=>{
 let now=0;const {display}=setup(t);display.now=()=>now;const a=display.open('android:a','a'),b=display.open('android:a','a');await display.stream(b.id,'a',new Response());now=15000;display.heartbeat(b.id,'a');now=21000;display.expire();assert.throws(()=>display.get(a.id,'a'),{code:'DISPLAY_EXPIRED'});assert.ok(display.get(b.id,'a'));now=36000;display.expire();assert.equal(display.sessions.size,0);
});
test('stop during startup aborts and drains the owned transport',async t=>{
 let aborted=false,closed=false;const display=new DisplaySessions(store,{start:async(_serial,{signal})=>{await new Promise(resolve=>{if(signal.aborted){aborted=true;resolve();}else signal.addEventListener('abort',()=>{aborted=true;resolve();});});return {stream:new PassThrough(),close:async()=>{closed=true;}};}});t.after(()=>display.close());const a=display.open('android:a','a'),pending=display.stream(a.id,'a',new Response());display.stop(a.id,'a');await pending;await display.close();assert.ok(aborted&&closed);
});
test('startup failure remains a coded HTTP error and releases the session',async t=>{
 const {problem}=require('../service/contract');const display=new DisplaySessions(store,{start:async()=>{throw problem('DISPLAY_ENCODER_MISSING',503);}});t.after(()=>display.close());const a=display.open('android:a','a'),r=new Response();await assert.rejects(display.stream(a.id,'a',r),{code:'DISPLAY_ENCODER_MISSING'});assert.equal(r.destroyed,undefined);assert.equal(display.sessions.size,0);
});
test('a stalled viewer is removed without ending a healthy viewer',async t=>{
 const {display,source,counts}=setup(t),a=display.open('android:a','a'),b=display.open('android:a','a'),slow=new Response(),fast=new Response();await display.stream(a.id,'a',slow);await display.stream(b.id,'a',fast);slow.writableLength=3*1024*1024;source.write(Buffer.concat([meta,packet(128,'config'),packet(64,'key')]));assert.equal(slow.destroyed,true);assert.equal(fast.destroyed,undefined);assert.equal(fast.data.length,3);assert.equal(counts().closes,0);
});
test('live touch goes to the control socket in video pixels and keeps gesture timing',async t=>{
 const source=new PassThrough(),written=[],control={destroyed:false,write:b=>written.push({b,at:Date.now()})};
 const calls=[];const display=new DisplaySessions(store,{needsRoot:async()=>true,start:async(serial,options)=>{calls.push(options);return {stream:source,control,close:async()=>source.destroy()};}});
 t.after(()=>display.close());
 assert.throws(()=>display.touch('android:a',[{a:'down',x:.5,y:.5,t:0}]),{code:'DISPLAY_REQUIRED'});
 const a=display.open('android:a','a');await display.stream(a.id,'a',new Response());source.write(meta);
 assert.equal(calls[0].control,true);assert.equal(calls[0].root,true);
 assert.throws(()=>display.touch('android:a',[{a:'tap',x:.5,y:.5,t:0}]),{code:'INVALID_TOUCH'});
 assert.throws(()=>display.touch('android:a',[{a:'down',x:2,y:.5,t:0}]),{code:'INVALID_TOUCH'});
 display.touch('android:a',[{a:'down',x:0,y:0,t:1000},{a:'move',x:.5,y:.5,t:1100}]);
 display.touch('android:a',[{a:'up',x:1,y:1,t:1200}]);
 await new Promise(r=>setTimeout(r,400));
 assert.equal(written.length,3);
 const [down,move,up]=written.map(w=>w.b);
 assert.deepEqual([down[0],down[1],move[1],up[1]],[2,0,2,1]);
 // meta is 1080x2336: the far corner is (1079,2335) and the size travels with each event
 assert.deepEqual([up.readInt32BE(10),up.readInt32BE(14),up.readUInt16BE(18),up.readUInt16BE(20)],[1079,2335,1080,2336]);
 assert.ok(written[2].at-written[0].at>=150,'gesture keeps its 200 ms span');
});
test('a phone without a control socket still streams video',async t=>{
 const source=new PassThrough(),calls=[];
 const display=new DisplaySessions(store,{start:async(serial,options)=>{calls.push(options);if(options.control)throw new Error('no control');return {stream:source,close:async()=>source.destroy()};}});
 t.after(()=>display.close());
 const a=display.open('android:a','a'),r=new Response();await display.stream(a.id,'a',r);source.write(meta);
 assert.deepEqual(calls.map(c=>!!c.control),[true,false]);
 assert.equal(r.data.length,1);
 assert.throws(()=>display.touch('android:a',[{a:'down',x:.5,y:.5,t:0}]),{code:'TOUCH_UNAVAILABLE'});
});
