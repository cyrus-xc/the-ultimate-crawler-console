'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');const {PassThrough,Writable}=require('node:stream');
const {captureResponse}=require('../adapters/xhs-phone/capture');
function fixture({result={operation:'search',status:200,response:{data:'咖啡'},request:{path:'/search'}},malformed=false}={}){
 const child=new EventEmitter();child.stdout=new PassThrough();let initial=true,closed=false;
 child.kill=()=>{if(!closed){closed=true;setImmediate(()=>child.emit('close',1));}return true;};
 child.stdin=new Writable({write(data,encoding,callback){
  if(initial){initial=false;setImmediate(()=>child.stdout.write(malformed?'invalid\n'+JSON.stringify({event:'perform_action'})+'\n':JSON.stringify({event:'perform_action'})+'\n'));}
  else {
   const wire=Buffer.from(JSON.stringify({event:'result',result})+'\n');
   const index=wire.indexOf(Buffer.from('咖'))+1;
   child.stdout.write(wire.subarray(0,index));child.stdout.write(wire.subarray(index));
   setImmediate(()=>{closed=true;child.emit('close',0);});
  }
  callback();
 }});
 return {child,options:{python:'fixture',contractPath:'fixture',endpoint:'127.0.0.1:1234',pid:123,operation:'search',values:{},guard:()=>{},trigger:async()=>{},spawnProcess:()=>child}};
}
test('capture preserves Unicode across stdout chunks and waits for child close',async()=>{
 const {options}=fixture();const result=await captureResponse(options);assert.equal(result.response.data,'咖啡');
});
test('invalid observer output cannot trigger an input from later buffered messages',async()=>{
 const {options}=fixture({malformed:true});let inputs=0;await assert.rejects(captureResponse({...options,trigger:async()=>{inputs++;}}),{code:'CAPTURE_PROTOCOL_INVALID'});assert.equal(inputs,0);
});
test('aborted capture drains the started input before releasing execution',async()=>{
 const {options}=fixture(),controller=new AbortController();let release,started;
 const ready=new Promise(resolve=>{started=resolve;});let settled=false;
 const result=captureResponse({...options,signal:controller.signal,trigger:()=>{started();return new Promise(resolve=>{release=resolve;});}});
 const observed=result.then(()=>{settled=true;},e=>{settled=true;assert.equal(e.code,'STOP_REQUESTED');});
 await ready;controller.abort(Object.assign(Error('stop'),{code:'STOP_REQUESTED'}));await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);
 release();await observed;assert.equal(settled,true);
});
test('mismatched operation cannot become a valid captured response',async()=>{
 const {options}=fixture({result:{operation:'other',status:200,response:{},request:{}}});await assert.rejects(captureResponse(options),{code:'CAPTURE_PROTOCOL_INVALID'});
});

test('unserializable input is rejected before spawning an observer',async()=>{
 const {options}=fixture();const values={};values.self=values;let spawned=false;
 await assert.rejects(captureResponse({...options,values,spawnProcess:()=>{spawned=true;}}),{code:'INVALID_CAPTURE_INPUT'});
 assert.equal(spawned,false);
});
