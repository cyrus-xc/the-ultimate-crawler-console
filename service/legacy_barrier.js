'use strict';
const fs=require('node:fs'),path=require('node:path');const {fork}=require('node:child_process');const {problem}=require('./contract');
class LegacyBarrier {
 constructor(root){
  if(typeof root!=='string'||!path.isAbsolute(root))throw problem('LEGACY_LOCK_DIRECTORY_REQUIRED',500);
  this.root=root;this.file=path.join(root,'.worker.lock');this.held=false;this.guardian=null;this.guardianPid=null;
 }
 async acquire(){
  if(this.held)return;
  const child=fork(path.join(__dirname,'legacy_guardian.js'),[this.root],{detached:true,stdio:['ignore','ignore','ignore','ipc'],env:{...process.env,ENABLE_TIKHUB_NETWORK:'0',ENABLE_LLM_NETWORK:'0'}});
  this.guardian=child;
  try{
   await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>done(problem('LEGACY_BARRIER_START_TIMEOUT',503)),5000);
    const onError=()=>done(problem('LEGACY_BARRIER_START_FAILED',503));
    const onExit=()=>done(problem('LEGACY_BARRIER_START_FAILED',503));
    const onMessage=message=>{
     if(message?.event==='ready'&&message.pid===child.pid){this.guardianPid=child.pid;this.held=true;done();}
     else if(message?.event==='error')done(problem(['LEGACY_WORKER_BUSY','LEGACY_LOCK_REQUIRES_RECOVERY'].includes(message.code)?message.code:'LEGACY_BARRIER_FAILED',409));
    };
    const done=error=>{clearTimeout(timer);child.removeListener('message',onMessage);child.removeListener('error',onError);child.removeListener('exit',onExit);error?reject(error):resolve();};
    child.on('message',onMessage);child.once('error',onError);child.once('exit',onExit);
   });
   child.unref();child.channel?.unref();
  }catch(error){child.kill();throw error;}
 }
 assert(){
  let owner;try{owner=fs.readFileSync(this.file,'utf8');}catch{}
  if(!this.held||!this.guardian?.connected||this.guardian.exitCode!==null||owner!==String(this.guardianPid))throw problem('LEGACY_BARRIER_LOST',409);
 }
 async release(){
  if(!this.held)return;
  const child=this.guardian;
  if(!child?.connected)throw problem('LEGACY_BARRIER_RELEASE_FAILED',503);
  await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>done(problem('LEGACY_BARRIER_RELEASE_FAILED',503)),5000);
   const onMessage=message=>{if(message?.event==='released')done();else if(message?.event==='error')done(problem('LEGACY_BARRIER_RELEASE_FAILED',503));};
   const onExit=()=>{let owner;try{owner=fs.readFileSync(this.file,'utf8');}catch{}done(owner===String(this.guardianPid)?problem('LEGACY_BARRIER_RELEASE_FAILED',503):null);};
   const done=error=>{clearTimeout(timer);child.removeListener('message',onMessage);child.removeListener('exit',onExit);error?reject(error):resolve();};
   child.on('message',onMessage);child.once('exit',onExit);child.send({action:'release'},error=>{if(error)done(problem('LEGACY_BARRIER_RELEASE_FAILED',503));});
  });
  this.held=false;
 }
}
module.exports={LegacyBarrier};
