'use strict';
// Separate lifetime from the HTTP service: an unexpected parent exit must not
// let an old worker reclaim the global lock while orphan ADB input may remain.
const fs=require('node:fs'),path=require('node:path');
const root=process.argv[2];if(!root||!path.isAbsolute(root)||!process.send)process.exit(1);
const file=path.join(root,'.worker.lock');let held=false;
const keepalive=setInterval(()=>{},1000);
const send=message=>{if(process.connected)process.send(message);};
process.on('disconnect',()=>{}); // Deliberately fail closed; no automatic unlink.
process.on('message',message=>{
 if(message?.action!=='release')return;
 try{if(held&&fs.readFileSync(file,'utf8')===String(process.pid))fs.unlinkSync(file);}
 catch(error){if(error.code!=='ENOENT'){send({event:'error',code:'LEGACY_BARRIER_RELEASE_FAILED'});return;}}
 held=false;clearInterval(keepalive);send({event:'released'});process.exit(0);
});
try{
 fs.mkdirSync(root,{recursive:true,mode:0o700});fs.writeFileSync(file,String(process.pid),{flag:'wx',mode:0o600});held=true;
 send({event:'ready',pid:process.pid});
}catch(error){
 let code='LEGACY_BARRIER_FAILED';
 if(error.code==='EEXIST'){
  code='LEGACY_LOCK_REQUIRES_RECOVERY';
  try{const owner=Number(fs.readFileSync(file,'utf8'));if(Number.isSafeInteger(owner)&&owner>0){try{process.kill(owner,0);code='LEGACY_WORKER_BUSY';}catch(e){if(e.code==='EPERM')code='LEGACY_WORKER_BUSY';}}}catch{}
 }
 send({event:'error',code});clearInterval(keepalive);process.exit(1);
}
