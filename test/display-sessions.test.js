const test=require('node:test'),assert=require('node:assert/strict');
const {DisplaySessions}=require('../service/display_sessions');
const png=Buffer.from([137,80,78,71,13,10,26,10,1]);
const store={devices:()=>[{id:'android:a',kind:'android',serial:'a'}]};
test('screens remain idle until explicitly read; viewers share a frame and expiry stops access',async t=>{
 let now=0,calls=0;const display=new DisplaySessions(store,{now:()=>now,execute:async(_bin,args)=>{calls++;assert.deepEqual(args,['-s','a','exec-out','screencap','-p']);return {stdout:png};}});t.after(()=>display.close());
 assert.equal(calls,0);const a=display.open('android:a','a'),b=display.open('android:a','a');assert.equal(calls,0);
 assert.deepEqual(await display.frame(a.id,'a'),png);await display.frame(b.id,'a');assert.equal(calls,1);
 await assert.rejects(display.frame(a.id,'other'),{code:'DISPLAY_EXPIRED'});
 display.stop(a.id,'a');now=21000;display.expire();await assert.rejects(display.frame(b.id,'a'),{code:'DISPLAY_EXPIRED'});assert.equal(display.frames.size,0);
});
test('last viewer stop aborts an in-flight read and never creates device input',async t=>{
 let aborted=false;const display=new DisplaySessions(store,{execute:async(_bin,_args,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(Error('abort'));}))});t.after(()=>display.close());
 const s=display.open('android:a','a'),pending=display.frame(s.id,'a');display.stop(s.id,'a');await assert.rejects(pending,{code:'DISPLAY_UNAVAILABLE'});assert.equal(aborted,true);
});
