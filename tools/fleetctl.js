#!/usr/bin/env node
'use strict';
// Operator switch for the crawler devices.
//   fleetctl status
//   fleetctl set <device> <off|crawl|nurture|mixed> [--project NAME]... [--topic WORD]... [--hours N]
// <device> is a device id or an alias: redmi, gm, web (see ALIASES).
// Reads CRAWLER_SERVICE_URL / CRAWLER_SERVICE_TOKEN_FILE from the environment
// or from ~/Development/xhs-analysis/.env.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');

const ALIASES={redmi:'android:7e9c701e',gm:'android:c7dee0b3',oneplus:'android:c7dee0b3',web:'web:xhs:default'};

function readEnv(file){
 const env={};
 try{for(const line of fs.readFileSync(file,'utf8').split('\n')){const m=line.match(/^([A-Z0-9_]+)=(.*)$/);if(m)env[m[1]]=m[2].trim().replace(/^"|"$/g,'');}}catch{}
 return env;
}
function service(){
 const env={...readEnv(path.join(os.homedir(),'Development/xhs-analysis/.env')),...process.env};
 const file=(env.CRAWLER_SERVICE_TOKEN_FILE||'').replace('$HOME',os.homedir()).replace(/^~(?=\/)/,os.homedir());
 if(!env.CRAWLER_SERVICE_URL||!file)throw new Error('CRAWLER_SERVICE_URL and CRAWLER_SERVICE_TOKEN_FILE are required');
 return {url:env.CRAWLER_SERVICE_URL.replace(/\/$/,''),token:fs.readFileSync(file,'utf8').trim()};
}
function parse(argv){
 const [command,...rest]=argv,out={command,projects:[],topics:[]};
 for(let i=0;i<rest.length;i++){
  const a=rest[i];
  if(a==='--project')out.projects.push(rest[++i]);
  else if(a==='--topic')out.topics.push(rest[++i]);
  else if(a==='--hours')out.hours=Number(rest[++i]);
  else (out.args??=[]).push(a);
 }
 return out;
}
async function call(svc,method,route,body){
 const res=await fetch(svc.url+route,{method,headers:{Authorization:'Bearer '+svc.token,'Content-Type':'application/json'},
  body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
 const value=await res.json().catch(()=>({}));
 if(!res.ok)throw new Error(value.error?.code||value.code||(typeof value.error==='string'?value.error:'')||'HTTP_'+res.status);
 return value;
}
const fmt=d=>[d.device_id.padEnd(20),d.mode.padEnd(8),String(d.health).padEnd(13),
 (Object.values(d.faults||{}).join(',')||'-').padEnd(24),d.projects.length?'projects='+d.projects.join(','):'',
 d.topics.length?'topics='+d.topics.join(','):'',d.until?'until='+new Date(d.until).toISOString():''].join(' ').trimEnd();

async function main(argv=process.argv.slice(2),svc=null){
 const o=parse(argv);
 if(o.command==='status'){
  const {devices}=await call(svc||service(),'GET','/v1/devices/modes');
  return devices.map(fmt).join('\n');
 }
 if(o.command==='set'&&o.args?.length===2){
  const device_id=ALIASES[o.args[0]]||o.args[0];
  const body={device_id,mode:o.args[1],...(o.projects.length?{projects:o.projects}:{}),...(o.topics.length?{topics:o.topics}:{}),...(o.hours?{hours:o.hours}:{})};
  const value=await call(svc||service(),'POST','/v1/devices/mode',body);
  return fmt({...value,health:'',faults:{}});
 }
 if(o.command==='activities'){
  const {activities}=await call(svc||service(),'GET','/v1/activities'+(o.args?.[0]?'?state='+encodeURIComponent(o.args[0]):''));
  return activities.map(a=>[(a.kind==='follow'?'F':'P')+a.id,a.kind.padEnd(7),a.state.padEnd(9),a.device_id,
   a.kind==='follow'?(a.payload.nickname||'')+' '+a.payload.user_id:a.payload.title,a.result?.code||''].join('  ').trimEnd()).join('\n')||'(none)';
 }
 if(['approve','reject'].includes(o.command)&&o.args?.length===1){
  const id=o.args[0].replace(/^[FP]/i,'');
  const a=await call(svc||service(),'POST',`/v1/activities/${encodeURIComponent(id)}/${o.command}`,{by:'fleetctl'});
  return `${a.kind} ${a.id} ${a.state}`;
 }
 if(o.command==='follow'&&o.args?.length===1){
  const a=await call(svc||service(),'POST','/v1/activities',{kind:'follow',device_id:ALIASES.web,payload:{user_id:o.args[0]},note:'fleetctl'});
  return `F${a.id} ${a.state}`;
 }
 if(o.command==='post'&&o.args?.length===1){
  const draft=JSON.parse(fs.readFileSync(o.args[0],'utf8'));
  const a=await call(svc||service(),'POST','/v1/activities',{kind:'publish',device_id:ALIASES.web,payload:draft,note:'fleetctl'});
  return `P${a.id} ${a.state} (approve with: fleetctl approve P${a.id})`;
 }
 throw new Error('usage: fleetctl status | set <redmi|gm|web|device-id> <off|crawl|nurture|mixed> [--project NAME] [--topic WORD] [--hours N]\n'+
  '       fleetctl activities [state] | approve <F12|P3> | reject <F12|P3> | follow <user_id> | post <draft.json>');
}
module.exports={main,parse,ALIASES};
if(require.main===module)main().then(text=>console.log(text),error=>{console.error(error.message);process.exit(1);});
