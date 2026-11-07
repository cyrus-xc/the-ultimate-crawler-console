'use strict';
const path=require('node:path');const {spawn}=require('node:child_process');
const {checkpoint,error}=require('./adapter');
async function sharePage(adapter,ctx){
 if(ctx.claim.payload.cache.mode==='only')throw error('CACHE_MISS','item');
 const wait=Math.max(0,(adapter.shareLast||0)+1500-Date.now());if(wait)await new Promise(resolve=>setTimeout(resolve,wait));ctx.guard();adapter.shareLast=Date.now();
 const result=await ctx.input(()=>new Promise((resolve,reject)=>{
  const child=spawn(adapter.env.CRAWLER_PYTHON||'python3',[path.join(__dirname,'share_page.py')],{env:adapter.env,stdio:['pipe','pipe','ignore']});adapter.shareChild=child;let out='',oversize=false;
  const abort=()=>child.kill('SIGTERM');ctx.signal.addEventListener('abort',abort,{once:true});
  child.stdout.on('data',chunk=>{out+=chunk;if(out.length>4*1024*1024){oversize=true;abort();}});child.stdin.on('error',()=>{});child.on('error',()=>reject(error('SHARE_PAGE_RUNTIME_UNAVAILABLE')));
  child.on('close',()=>{ctx.signal.removeEventListener('abort',abort);adapter.shareChild=null;if(ctx.signal.aborted)return reject(error('STOP_REQUESTED','item'));if(oversize)return reject(error('SHARE_PAGE_TOO_LARGE','item'));let value;try{value=JSON.parse(out);}catch{return reject(error('SHARE_PAGE_PROTOCOL'));}if(!value.success)return reject(error(/^[A-Z][A-Z0-9_]+$/.test(value.error)?value.error:'SHARE_PAGE_UNAVAILABLE',value.error==='VERIFICATION_REQUIRED'?'platform':'item'));resolve(value.data);});
  child.stdin.end(JSON.stringify({...ctx.claim.payload,target:ctx.claim.target})+'\n');
 }));
 ctx.commit({items:[{key:'result',value:{phase:'result',data:result,observed_at:new Date().toISOString()}}],checkpoint:checkpoint(ctx,adapter.version,new Set(ctx.resume.seen_ids))});await ctx.waitForDecision();
}
module.exports={sharePage};
