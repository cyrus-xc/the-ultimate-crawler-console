'use strict';
// Append-only record of phone input (tap/swipe/keyevent/navigation) and UI
// incidents, one JSON line per event, one file per local day. It is evidence for
// pacing review only: failures to write never affect collection.
const fs=require('node:fs'),path=require('node:path');

const DAY=86400000, OFFSET=8*3600000;
const dayKey=ms=>new Date(Math.floor((ms+OFFSET)/DAY)*DAY).toISOString().slice(0,10);

function createInputLog(dir,{now=Date.now,retainDays=14}={}){
 let prunedFor=null;
 const prune=key=>{
  if(prunedFor===key)return;prunedFor=key;
  const oldest=dayKey(now()-retainDays*DAY);
  try{for(const name of fs.readdirSync(dir))if(/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)&&name.slice(0,10)<oldest)fs.rmSync(path.join(dir,name),{force:true});}catch{}
 };
 const record=(deviceId,event)=>{
  try{
   const at=now(),key=dayKey(at);
   fs.mkdirSync(dir,{recursive:true,mode:0o700});prune(key);
   fs.appendFileSync(path.join(dir,key+'.jsonl'),JSON.stringify({at,device_id:deviceId,...event})+'\n',{mode:0o600});
  }catch{/* evidence only */}
 };
 record.dir=dir;
 return record;
}
// Classify a validated gateway shell command for the log; null means not input.
function describeInput(words){
 const [command,action,...values]=words;
 if(command==='input'&&['tap','swipe','keyevent'].includes(action))return {kind:action,values:values.map(Number)};
 if(command==='am'&&action==='start')return {kind:'open_link',target:String(values[3]||'').replace(/[a-f0-9]{24}/gi,m=>m.slice(0,6)+'…')};
 if(command==='monkey')return {kind:'launch_app',package:values[0]};
 return null;
}
module.exports={createInputLog,describeInput,dayKey};
