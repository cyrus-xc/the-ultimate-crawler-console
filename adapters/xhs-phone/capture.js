'use strict';
const {spawn}=require('node:child_process');const {StringDecoder}=require('node:string_decoder');const path=require('node:path');
const error=code=>Object.assign(Error(code),{code,scope:'device'});
async function captureResponse({python,contractPath,endpoint,pid,operation,values,trigger,guard,signal,timeoutSeconds=45,privateMedia=false,spawnProcess=spawn}){
 if(typeof guard!=='function'||typeof trigger!=='function'||!Number.isInteger(pid)||pid<1||!/^127\.0\.0\.1:\d{1,5}$/.test(endpoint)||!Number.isFinite(timeoutSeconds)||timeoutSeconds<=0||timeoutSeconds>300)throw error('INVALID_CAPTURE_CONFIG');
 let encoded;try{encoded=JSON.stringify(values);}catch{throw error('INVALID_CAPTURE_INPUT');}
 if(!values||typeof values!=='object'||Array.isArray(values)||Buffer.byteLength(encoded)>1024*1024)throw error('INVALID_CAPTURE_INPUT');
 await guard();if(signal?.aborted)throw signal.reason;
 const child=spawnProcess(python,['-B',path.join(__dirname,'capture_cli.py'),'--contract',contractPath,'--endpoint',endpoint,'--pid',String(pid),'--operation',operation,'--timeout',String(timeoutSeconds),...(privateMedia?['--private-media']:[])],{stdio:['pipe','pipe','ignore'],env:{...process.env,ENABLE_TIKHUB_NETWORK:'0',ENABLE_LLM_NETWORK:'0'}});
 const decoder=new StringDecoder('utf8');let buffer='',bytes=0,result=null,failure=null,action=null,actionDone=false,responseReady=false,killTimer,actionFailure=null;
 const stop=reason=>{if(!failure)failure=reason;child.kill('SIGTERM');if(!killTimer)killTimer=setTimeout(()=>child.kill('SIGKILL'),2000);};
 const abort=()=>stop(signal.reason||error('STOP_REQUESTED'));
 const timer=setTimeout(()=>stop(error('CAPTURE_TIMEOUT')),timeoutSeconds*1000+10000);
 signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 child.stdin.on('error',()=>stop(error('CAPTURE_CHANNEL_CLOSED')));
 child.stdout.on('data',data=>{
  bytes+=data.length;if(bytes>8*1024*1024){stop(error('CAPTURE_OUTPUT_LIMIT'));return;}
  buffer+=decoder.write(data);let at;
  while((at=buffer.indexOf('\n'))>=0){
   const line=buffer.slice(0,at);buffer=buffer.slice(at+1);let message;
   try{message=JSON.parse(line);}catch{stop(error('CAPTURE_PROTOCOL_INVALID'));continue;}
   if(failure)continue;
   if(message.event==='perform_action'){
    if(action){stop(error('CAPTURE_PROTOCOL_INVALID'));continue;}
    action=(async()=>{await guard();if(signal?.aborted)throw signal.reason;await trigger({responseReady:()=>responseReady,guard:()=>{if(failure)throw failure;if(signal?.aborted)throw signal.reason;}});await guard();if(signal?.aborted)throw signal.reason;actionDone=true;child.stdin.write(JSON.stringify({action:'done'})+'\n');})().catch(reason=>{
     if(['PHONE_FIRST_PAGE_UNOBSERVED','PHONE_PAGE_RESPONSE_UNOBSERVED'].includes(reason?.code)){
      // Let the observer return bounded packet diagnostics before it detaches.
      actionFailure=reason;child.stdin.write(JSON.stringify({action:'failed',code:reason.code})+'\n');
     }else stop(reason);
    });
   }else if(message.event==='response_ready'){
    if(!action){stop(error('CAPTURE_PROTOCOL_INVALID'));continue;}responseReady=true;
   }else if(message.event==='result'){
    if(result||!actionDone||message.result?.operation!==operation||message.result?.status!==200||!message.result?.response||!message.result?.request){stop(error('CAPTURE_PROTOCOL_INVALID'));continue;}
    result=message.result;
   }else if(message.event==='error'){const failure=error(/^[A-Z][A-Z0-9_]{1,100}$/.test(message.code||'')?message.code:'CAPTURE_FAILED');if(message.diagnostics)failure.diagnostics=message.diagnostics;stop(failure);}
   else stop(error('CAPTURE_PROTOCOL_INVALID'));
  }
 });
 try{
  const code=await new Promise(resolve=>{child.once('error',()=>{failure=error('CAPTURE_LAUNCH_FAILED');});child.once('close',code=>{if(!failure&&(code!==0||!result))failure=error('CAPTURE_FAILED');resolve(code);});child.stdin.write(encoded+'\n');});
  // Do not release a device lease while a triggered ADB action is still draining.
  if(action)await action;
  if(failure)throw failure;
  if(actionFailure)throw actionFailure;
  if(code!==0||!result)throw error('CAPTURE_FAILED');
  return result;
 }finally{clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);}
}
// One long-lived observer process per App pid (observer_host.py). Hooks are
// installed once and reset per action; repeated install/remove crashed XHS.
class ObserverHost {
 constructor({python,contractPath,spawnProcess=spawn,startTimeoutMs=20000}={}){
  this.python=python;this.contractPath=contractPath;this.spawnProcess=spawnProcess;this.startTimeoutMs=startTimeoutMs;
  this.child=null;this.key=null;this.handler=null;this.busy=false;
 }
 alive(endpoint,pid){return !!this.child&&!this.child.exited&&this.key===`${endpoint}#${pid}`;}
 kill(){
  const child=this.child;this.child=null;this.key=null;this.handler=null;
  if(!child||child.exited)return child?.closed||Promise.resolve();
  child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),2000);
  return child.closed.finally(()=>clearTimeout(timer));
 }
 async close(){await this.kill();}
 async start(endpoint,pid){
  await this.kill();
  const child=this.spawnProcess(this.python,['-B',path.join(__dirname,'observer_host.py'),'--contract',this.contractPath,'--endpoint',endpoint,'--pid',String(pid)],{stdio:['pipe','pipe','ignore'],env:{...process.env,ENABLE_TIKHUB_NETWORK:'0',ENABLE_LLM_NETWORK:'0'}});
  child.exited=false;child.closed=new Promise(resolve=>{child.once('error',()=>{child.exited=true;resolve();});child.once('close',()=>{child.exited=true;resolve();});});
  child.stdin.on('error',()=>{});
  const decoder=new StringDecoder('utf8');let buffer='';
  child.stdout.on('data',data=>{
   buffer+=decoder.write(data);let at;
   if(buffer.length>8*1024*1024){this.handler?.({event:'__overflow__'});buffer='';return;}
   while((at=buffer.indexOf('\n'))>=0){
    const line=buffer.slice(0,at);buffer=buffer.slice(at+1);let message;
    try{message=JSON.parse(line);}catch{message={event:'__invalid__'};}
    if(this.child===child)this.handler?.(message);
   }
  });
  child.closed.then(()=>{if(this.child===child)this.handler?.({event:'__closed__'});});
  this.child=child;this.key=`${endpoint}#${pid}`;
  await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{this.handler=null;this.kill();reject(Object.assign(error('CAPTURE_FAILED'),{diagnostics:{exception_type:'ObserverStartTimeout',stage:'attachment'}}));},this.startTimeoutMs);
   this.handler=message=>{
    clearTimeout(timer);this.handler=null;
    if(message.event==='host_ready')return resolve();
    const failure=error(message.event==='error'&&/^[A-Z][A-Z0-9_]{1,100}$/.test(message.code||'')?message.code:'CAPTURE_FAILED');
    failure.diagnostics=message.diagnostics||{exception_type:'ObserverStartFailed',stage:'attachment'};
    this.kill();reject(failure);
   };
  });
 }
 async capture({endpoint,pid,operation,values,trigger,guard,signal,timeoutSeconds=45,privateMedia=false}){
  if(typeof guard!=='function'||typeof trigger!=='function'||!Number.isInteger(pid)||pid<1||!/^127\.0\.0\.1:\d{1,5}$/.test(endpoint)||!Number.isFinite(timeoutSeconds)||timeoutSeconds<=0||timeoutSeconds>300)throw error('INVALID_CAPTURE_CONFIG');
  let encoded;try{encoded=JSON.stringify({operation,values,timeout:timeoutSeconds,private_media:privateMedia===true});}catch{throw error('INVALID_CAPTURE_INPUT');}
  if(!values||typeof values!=='object'||Array.isArray(values)||Buffer.byteLength(encoded)>1024*1024)throw error('INVALID_CAPTURE_INPUT');
  if(this.busy)throw error('CAPTURE_PROTOCOL_INVALID');
  await guard();if(signal?.aborted)throw signal.reason;
  this.busy=true;
  try{
   if(!this.alive(endpoint,pid))await this.start(endpoint,pid);
   await guard();if(signal?.aborted)throw signal.reason;
   const child=this.child;
   let result=null,failure=null,action=null,actionDone=false,responseReady=false,actionFailure=null,finish;
   const finished=new Promise(resolve=>{finish=resolve;});
   // An abandoned action leaves the observer in an unknown state: replace it.
   const stop=reason=>{if(!failure)failure=reason;this.kill();finish();};
   const abort=()=>stop(signal.reason||error('STOP_REQUESTED'));
   const timer=setTimeout(()=>stop(error('CAPTURE_TIMEOUT')),timeoutSeconds*1000+10000);
   signal?.addEventListener('abort',abort,{once:true});
   this.handler=message=>{
    if(failure||result)return;
    if(message.event==='perform_action'){
     if(action){stop(error('CAPTURE_PROTOCOL_INVALID'));return;}
     action=(async()=>{await guard();if(signal?.aborted)throw signal.reason;await trigger({responseReady:()=>responseReady,guard:()=>{if(failure)throw failure;if(signal?.aborted)throw signal.reason;}});await guard();if(signal?.aborted)throw signal.reason;actionDone=true;child.stdin.write(JSON.stringify({action:'done'})+'\n');})().catch(reason=>{
      if(['PHONE_FIRST_PAGE_UNOBSERVED','PHONE_PAGE_RESPONSE_UNOBSERVED'].includes(reason?.code)){
       actionFailure=reason;child.stdin.write(JSON.stringify({action:'failed',code:reason.code})+'\n');
      }else stop(reason);
     });
    }else if(message.event==='response_ready'){
     if(!action){stop(error('CAPTURE_PROTOCOL_INVALID'));return;}responseReady=true;
    }else if(message.event==='result'){
     if(!actionDone||message.result?.operation!==operation||message.result?.status!==200||!message.result?.response||!message.result?.request){stop(error('CAPTURE_PROTOCOL_INVALID'));return;}
     result=message.result;finish();
    }else if(message.event==='error'){
     const reported=error(/^[A-Z][A-Z0-9_]{1,100}$/.test(message.code||'')?message.code:'CAPTURE_FAILED');if(message.diagnostics)reported.diagnostics=message.diagnostics;
     failure=reported;
     // The host serves the next action after an ordinary capture error; a
     // detached App session or an error mid-action means it must be replaced.
     if(message.code==='OBSERVER_DETACHED'||(action&&!actionDone&&!actionFailure))this.kill();
     finish();
    }else if(message.event==='__closed__')stop(Object.assign(error('CAPTURE_FAILED'),{diagnostics:{exception_type:'ObserverExited',stage:'capture'}}));
    else stop(error(message.event==='__overflow__'?'CAPTURE_OUTPUT_LIMIT':'CAPTURE_PROTOCOL_INVALID'));
   };
   try{
    if(signal?.aborted)abort();else child.stdin.write(encoded+'\n');
    await finished;
    // Do not release a device lease while a triggered ADB action is still draining.
    if(action)await action.catch(()=>{});
    if(failure)throw failure;
    if(actionFailure)throw actionFailure;
    if(!result)throw error('CAPTURE_FAILED');
    return result;
   }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);if(this.child===child)this.handler=null;}
  }finally{this.busy=false;}
 }
}
module.exports={captureResponse,ObserverHost};
