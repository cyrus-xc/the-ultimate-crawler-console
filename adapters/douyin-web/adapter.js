'use strict';
const path=require('node:path'),fs=require('node:fs');const {spawn}=require('node:child_process');const {createInterface}=require('node:readline');
const {checkpoint,error}=require('../xhs-web/adapter');
class DouyinWebAdapter{
 constructor({env=process.env,spawnProcess=spawn}={}){this.env={...env};this.spawnProcess=spawnProcess;this.version='douyin-web-queue-v1';this.session=null;}
 ensure(){if(this.closing)throw error('SESSION_CLOSING');if(this.session&&!this.session.exited)return this.session;const child=this.spawnProcess(this.env.CRAWLER_PYTHON||'python3',['-u',path.join(__dirname,'worker.py')],{env:this.env,stdio:['pipe','pipe','ignore'],detached:process.platform!=='win32'});const session={child,exited:false,lines:createInterface({input:child.stdout,crlfDelay:Infinity})};session.iterator=session.lines[Symbol.asyncIterator]();session.closed=new Promise(resolve=>{child.once('error',()=>{session.exited=true;resolve();});child.once('close',()=>{session.exited=true;resolve();});});this.session=session;return session;}
 async execute(ctx){
  ctx.guard();if(ctx.claim.payload.cache.mode==='only')throw error('CACHE_MISS','item');const s=this.ensure(),seen=new Set(ctx.resume.seen_ids);let pageNo=0,stopped=false,operatorValue;
  const abort=()=>s.child.kill('SIGTERM');ctx.signal.addEventListener('abort',abort,{once:true});
  try{
   s.child.stdin.write(JSON.stringify({...ctx.claim.payload,target:ctx.claim.target,cursor:ctx.resume.cursor})+'\n');
   while(true){const {value,done}=await s.iterator.next();if(done)throw error(ctx.signal.aborted?'STOP_REQUESTED':'DOUYIN_WORKER_EXITED');ctx.guard();let event;try{event=JSON.parse(value);}catch{throw error('DOUYIN_WORKER_PROTOCOL');}
    if(event.type==='input'){if(stopped)throw error('INPUT_AFTER_STOP');await ctx.input(async()=>s.child.stdin.write('{"action":"continue"}\n'));}
    else if(event.type==='page'){
     pageNo++;const data=event.data;for(const item of data.items||[])seen.add(String(item.aweme_id||item.cid||item.sec_uid));
     const cp=checkpoint(ctx,this.version,seen);cp.cursor=data.cursor;
     ctx.commit({items:[{key:'page:'+String(data.cursor??pageNo),value:{phase:'page',data,observed_at:new Date().toISOString()}}],checkpoint:cp});
     const decision=await ctx.waitForDecision();const action=typeof decision==='object'?decision.action:decision;stopped=action==='stop';s.child.stdin.write(JSON.stringify({action})+'\n');
    }else if(event.type==='qr'){operatorValue=event.data;}else if(event.type==='done')return operatorValue;else if(event.type==='error')throw error(/^[A-Z][A-Z0-9_]+$/.test(event.code)?event.code:'DOUYIN_READ_FAILED',event.scope);else throw error('DOUYIN_WORKER_PROTOCOL');
   }
  }catch(e){if(e.scope!=='platform'||ctx.signal.aborted)await this.close();throw e;}finally{ctx.signal.removeEventListener('abort',abort);}
 }
 async desktop(options){return this.operatorAction('desktop',options);}
 async loginQr(options){return this.operatorAction('login_qr',options);}
 async resume(options){await this.operatorAction('resume',options);return {authenticated:true};}
 async operatorAction(operation,{guard=()=>{},signal}={}){
  const ctrl=new AbortController();return await this.execute({claim:{target:{},payload:{operation,params:{},limits:{},cache:{mode:'refresh'}}},resume:{seen_ids:[],binding:'desktop'},signal:signal||ctrl.signal,guard,input:async fn=>{guard();return fn();},commit(){},waitForDecision:async()=>'continue'});
 }
 async close(){if(this.closing)return this.closing;this.closing=this.closeOwned();try{return await this.closing;}finally{this.closing=null;}}
 async closeOwned(){const s=this.session;if(!s)return;this.session=null;if(!s.exited){s.child.kill('SIGTERM');const timer=setTimeout(()=>{try{if(process.platform!=='win32')process.kill(-s.child.pid,'SIGKILL');else s.child.kill('SIGKILL');}catch{}},5000);await s.closed;clearTimeout(timer);}s.lines.close();}
}
module.exports={DouyinWebAdapter};
