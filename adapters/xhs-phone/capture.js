'use strict';
const {spawn}=require('node:child_process');const {StringDecoder}=require('node:string_decoder');const path=require('node:path');
const error=code=>Object.assign(Error(code),{code,scope:'device'});
async function captureResponse({python,contractPath,endpoint,pid,operation,values,trigger,guard,signal,timeoutSeconds=45,spawnProcess=spawn}){
 if(typeof guard!=='function'||typeof trigger!=='function'||!Number.isInteger(pid)||pid<1||!/^127\.0\.0\.1:\d{1,5}$/.test(endpoint)||!Number.isFinite(timeoutSeconds)||timeoutSeconds<=0||timeoutSeconds>300)throw error('INVALID_CAPTURE_CONFIG');
 let encoded;try{encoded=JSON.stringify(values);}catch{throw error('INVALID_CAPTURE_INPUT');}
 if(!values||typeof values!=='object'||Array.isArray(values)||Buffer.byteLength(encoded)>1024*1024)throw error('INVALID_CAPTURE_INPUT');
 await guard();if(signal?.aborted)throw signal.reason;
 const child=spawnProcess(python,['-B',path.join(__dirname,'capture_cli.py'),'--contract',contractPath,'--endpoint',endpoint,'--pid',String(pid),'--operation',operation,'--timeout',String(timeoutSeconds)],{stdio:['pipe','pipe','ignore'],env:{...process.env,ENABLE_TIKHUB_NETWORK:'0',ENABLE_LLM_NETWORK:'0'}});
 const decoder=new StringDecoder('utf8');let buffer='',bytes=0,result=null,failure=null,action=null,actionDone=false,responseReady=false,killTimer;
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
    action=(async()=>{await guard();if(signal?.aborted)throw signal.reason;await trigger({responseReady:()=>responseReady});await guard();if(signal?.aborted)throw signal.reason;actionDone=true;child.stdin.write(JSON.stringify({action:'done'})+'\n');})().catch(stop);
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
  const code=await new Promise(resolve=>{child.once('error',()=>{failure=error('CAPTURE_LAUNCH_FAILED');});child.once('close',resolve);child.stdin.write(encoded+'\n');});
  // Do not release a device lease while a triggered ADB action is still draining.
  if(action)await action;
  if(failure)throw failure;
  if(code!==0||!result)throw error('CAPTURE_FAILED');
  return result;
 }finally{clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);}
}
module.exports={captureResponse};
