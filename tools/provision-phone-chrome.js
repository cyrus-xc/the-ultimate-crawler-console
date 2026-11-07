'use strict';
// Administrator helper: fixed service endpoints, never user-provided APK paths.
const fs=require('node:fs'),path=require('node:path');
function settings(env=process.env){
 const selected={};try{for(const line of fs.readFileSync(path.resolve(__dirname,'../.env'),'utf8').split(/\r?\n/)){const m=line.match(/^(CRAWLER_SERVICE_TOKEN_FILE|CRAWLER_PORT)=(.*)$/);if(m)selected[m[1]]=m[2].replace(/^['"]|['"]$/g,'');}}catch(error){if(error.code!=='ENOENT')throw error;}
 return {...selected,...env};
}
async function main(argv=process.argv.slice(2),env=settings()){
 const [action,serial]=argv;
 if(!['export','install'].includes(action)||!/^[-\w.:]+$/.test(serial||'')||argv.length!==2)throw Object.assign(Error('PROVISION_ARGUMENTS_REQUIRED'),{code:'PROVISION_ARGUMENTS_REQUIRED'});
 const token=fs.readFileSync(env.CRAWLER_SERVICE_TOKEN_FILE,'utf8').trim(),port=Number(env.CRAWLER_PORT||18323);
 if(token.length<32||!Number.isInteger(port)||port<1||port>65535)throw Object.assign(Error('INVALID_SERVICE_CONFIG'),{code:'INVALID_SERVICE_CONFIG'});
 async function call(route,body,timeout=20000){const response=await fetch(`http://127.0.0.1:${port}/v1/`+route,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(timeout)});const result=await response.json();if(!response.ok)throw Object.assign(Error(result.error?.code||'PROVISION_FAILED'),{code:result.error?.code||'PROVISION_FAILED'});return result;}
 const acquired=await call('device-leases',{serial,owner:'chrome-provision:'+process.pid});let lease=acquired.lease,heart=Promise.resolve(),lost;
 const timer=setInterval(()=>{heart=heart.then(async()=>{if(lost)return;try{lease=(await call('device-leases/heartbeat',{lease})).lease;}catch(error){lost=error;}});},Math.max(1000,Math.min(acquired.heartbeat_ms||5000,5000)));
 try{const result=await call('device-provision/'+(action==='export'?'chrome-export':'chrome'),{lease},240000);if(lost)throw lost;return result;}
 finally{clearInterval(timer);await heart;await call('device-leases/release',{lease});}
}
if(require.main===module)main().then(result=>process.stdout.write(JSON.stringify(result)+'\n')).catch(error=>{process.stderr.write((/^[A-Z][A-Z0-9_]+$/.test(error.code||'')?error.code:'PROVISION_FAILED')+'\n');process.exitCode=1;});
module.exports={main,settings};
