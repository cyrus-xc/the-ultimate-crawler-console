'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process');const {randomBytes}=require('node:crypto');
const {createInterface}=require('node:readline');
const error=(code,scope='device')=>Object.assign(Error(code),{code,scope});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const fields=new Set('profile_walk profile_walk_version profile_anchor_ids profile_skip_ids profile_end_policy capture_share select_share kind id keyword xsec_token user_id target seconds comments comment_mode comment_lazy_load_limit sort_by since'.split(' '));
const kinds={'search.posts':'search','profile.get':'profile','profile.posts':'profile','post.detail':'detail','post.comments':'detail','place.posts':'poi'};
function nativeRequest(claim){
 const p=claim.payload.params,t=claim.target,kind=kinds[claim.payload.operation];if(!kind)throw error('UNSUPPORTED_OPERATION','item');
 let q={kind,max_pages:claim.payload.limits.max_pages,stream_pages:true,target:p.max_items||50,seconds:Math.min(90,claim.payload.limits.execution_timeout_seconds),...(kind==='search'?{keyword:t.keyword,sort_by:p.sort||'综合'}:{id:t.user_id||t.post_id||t.place_id})};
 if(kind==='profile'&&p.published_after)q.since=Date.parse(p.published_after);
 if(claim.payload.operation==='post.comments')Object.assign(q,{comments:true,comment_mode:'limited_lazy_load_on_scroll',comment_lazy_load_limit:Math.min(20,claim.payload.limits.max_pages)});
 if(p.native_request){if(typeof p.native_request!=='object'||Object.keys(p.native_request).some(k=>!fields.has(k)))throw error('INVALID_NATIVE_REQUEST','item');q={...q,...p.native_request};}
 if(q.kind!==kind||kind==='search'&&q.keyword!==t.keyword||kind!=='search'&&q.id!==(t.user_id||t.post_id||t.place_id))throw error('TARGET_MISMATCH','item');
 if(q.profile_end_policy!==undefined&&(q.profile_end_policy!=='observed_terminal_v1'||kind!=='profile'||q.profile_walk||q.since||!(q.target>0)))throw error('INVALID_PROFILE_END_POLICY','item');
 if(t.observed_url){let u;try{u=new URL(t.observed_url);}catch{throw error('INVALID_OBSERVED_URL','item');}if(u.protocol!=='https:'||!['www.xiaohongshu.com','xiaohongshu.com'].includes(u.hostname)||u.pathname.split('/').filter(Boolean).at(-1)!==q.id)throw error('INVALID_OBSERVED_URL','item');q.xsec_token=u.searchParams.get('xsec_token')||q.xsec_token;}
 if(p.filters&&Object.keys(p.filters).length)throw error('UNSUPPORTED_FILTER','item');
 return q;
}
function checkpoint(ctx,version,seen,decision){return {binding:ctx.resume.binding,device_id:ctx.claim.device_id,adapter_version:version,cursor:null,seen_ids:[...seen],...(decision?{decision}:{})};}
class XhsWebAdapter{
 constructor({env=process.env,spawnProcess=spawn}={}){this.env={...env};this.spawnProcess=spawnProcess;this.version='xhs-web-queue-v1';this.session=null;this.starting=null;}
 async ensure(){
  if(this.closing)await this.closing;
  if(this.session&&!this.session.exited)return this.session;if(this.starting)return this.starting;
  this.starting=(async()=>{
   if(!this.env.XHS_CRAWLER_BIN||!fs.existsSync(this.env.XHS_CRAWLER_BIN))throw error('XHS_CRAWLER_BINARY_MISSING');
   const display=this.env.CRAWLER_WAYLAND_DISPLAY,desktop=path.join(this.env.XDG_RUNTIME_DIR||'/run/user/'+process.getuid(),display||'');if(!/^wayland-[0-9]+$/.test(display||'')||!fs.existsSync(desktop)||!fs.statSync(desktop).isSocket())throw error('HIDDEN_DESKTOP_UNAVAILABLE');
   const root=path.resolve(this.env.CRAWLER_RUNTIME_DIR||'runtime');fs.mkdirSync(root,{recursive:true,mode:0o700});const dir=fs.mkdtempSync(path.join(root,'xhs-session-')),ready=path.join(dir,'ready.json'),token=randomBytes(32).toString('hex');
   const child=this.spawnProcess(this.env.XHS_CRAWLER_BIN,['serve'],{env:{...this.env,XHS_SESSION_READY:ready,XHS_SESSION_TOKEN:token,XHS_CRAWLER_TABS:'1',XHS_CRAWLER_HEADFUL:'true',XHS_BROWSER_CLASS:'ultimate-crawler-xhs',XHS_CRAWLER_DEBUG_LOG:'',WAYLAND_DISPLAY:this.env.CRAWLER_WAYLAND_DISPLAY||this.env.WAYLAND_DISPLAY,DISPLAY:''},stdio:['ignore','ignore','ignore'],detached:process.platform!=='win32'});
   const session={child,dir,token,exited:false};session.closed=new Promise(resolve=>{child.once('error',()=>{session.exited=true;resolve();});child.once('close',()=>{session.exited=true;resolve();});});this.session=session;
   for(let n=0;n<200;n++){if(session.exited)throw error('XHS_SESSION_START_FAILED');if(fs.existsSync(ready)){const data=JSON.parse(fs.readFileSync(ready));if(data.pid!==child.pid||!Number.isInteger(data.port))throw error('XHS_SESSION_READY_INVALID');session.port=data.port;return session;}await pause(50);}
   await this.close();throw error('XHS_SESSION_START_TIMEOUT');
  })();try{return await this.starting;}finally{this.starting=null;}
 }
 request(session,route,body,signal){return new Promise((resolve,reject)=>{const data=JSON.stringify(body);const req=http.request({hostname:'127.0.0.1',port:session.port,path:route,method:'POST',headers:{Authorization:'Bearer '+session.token,'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)},signal},res=>{if(res.statusCode!==200){res.resume();reject(error('XHS_SESSION_PROTOCOL'));}else resolve(res);});req.on('error',()=>reject(error(signal?.aborted?'STOP_REQUESTED':'XHS_SESSION_UNAVAILABLE')));req.end(data);});}
 async execute(ctx){
  if(ctx.claim.payload.operation==='link.resolve'||['share_page','mobile_metadata','mobile_detail'].includes(ctx.claim.payload.params.native_request?.representation))return require('./share_page').sharePage(this,ctx);
  const q=nativeRequest(ctx.claim);if(ctx.claim.payload.cache.mode==='only')throw error('CACHE_MISS','item');ctx.guard();const session=await this.ensure();const seen=new Set(ctx.resume.seen_ids);let final=false,pageIndex=0;
  try{
   const response=await ctx.input(()=>this.request(session,'/read',q,ctx.signal));
   for await(const line of createInterface({input:response,crlfDelay:Infinity})){
    ctx.guard();let event;try{event=JSON.parse(line);}catch{throw error('XHS_SESSION_PROTOCOL');}
    if(event.phase){
     const key=event.phase==='page'?'page:'+ ++pageIndex:event.phase+':'+event.note_id;const decision=event.phase==='page'?{phase:'page'}:{phase:event.phase,subject_id:event.note_id};
     // Remove standalone access parameters; observed share URLs remain evidence.
     const data={...event.data};delete data.xsec_token;
     ctx.commit({items:[{key,value:{phase:event.phase,note_id:event.note_id,data,observed_at:new Date().toISOString()}}],checkpoint:checkpoint(ctx,this.version,seen,decision)});
     const choice=await ctx.waitForDecision();const capture=event.phase==='detail_ready'?(typeof choice==='object'?choice.capture_share===true:true):(typeof choice==='object'?choice.action!=='stop':choice!=='stop');
     if(capture&&event.phase==='profile_note')seen.add(event.note_id);
     if((typeof choice==='object'?choice.action:choice)==='stop'){await this.close();return;}
     const reply=await this.request(session,'/share-decision',{decision_id:event.decision_id,note_id:event.note_id,capture},ctx.signal);for await(const _ of reply){}
     continue;
    }
    if(!event.success)throw error(/^[A-Z][A-Z0-9_]+$/.test(event.error)?event.error:'XHS_READ_FAILED',event.error==='INVALID_BUDGET'?'item':/LOGIN|CAPTCHA|VERIFICATION|ACCOUNT/.test(event.error)?'platform':'device');
    final=true;ctx.commit({items:[{key:'result',value:{phase:'result',data:event.data,observed_at:new Date().toISOString()}}],checkpoint:checkpoint(ctx,this.version,seen)});await ctx.waitForDecision();
   }
   if(!final)throw error('XHS_RESULT_MISSING');
  }catch(e){if(e.scope!=='platform'||ctx.signal.aborted)await this.close();throw e;}
 }
 async desktop({guard=()=>{},signal}={}){guard();const session=await this.ensure();guard();const response=await this.request(session,'/desktop',{},signal);for await(const _ of response){}guard();return {opened:true};}
 async loginQr({guard=()=>{},signal}={}){guard();const session=await this.ensure();guard();const response=await this.request(session,'/desktop/qr',{},signal);let body='';for await(const chunk of response){body+=chunk;if(body.length>3*1024*1024)throw error('LOGIN_QR_TOO_LARGE');}const result=JSON.parse(body);guard();if(!result.success)throw error('LOGIN_QR_UNAVAILABLE','platform');return {authenticated:result.authenticated===true,png_base64:result.png_base64};}
 async resume({guard=()=>{},signal}={}){
  guard();const session=await this.ensure();
  for(let attempt=0;attempt<7;attempt++){
   guard();if(signal?.aborted)throw error('STOP_REQUESTED');const response=await this.request(session,'/desktop/confirm',{},signal);let body='';for await(const chunk of response)body+=chunk;
   let result;try{result=JSON.parse(body);}catch{throw error('XHS_SESSION_PROTOCOL');}
   if(result.success){guard();return {authenticated:true};}
   const code=/^[A-Z][A-Z0-9_]+$/.test(result.error)?result.error:'LOGIN_STATE_UNAVAILABLE';
   if(!['LOGIN_REQUIRED','LOGIN_STATE_UNAVAILABLE'].includes(code)||attempt===6)throw error(code,'platform');
   // Read-only polling lets an operator-opened page finish hydration. No
   // navigation, credential injection, or fault clearance occurs on a false.
   await pause(500);
  }
 }

 async close(){if(this.closing)return this.closing;this.closing=this.closeOwned();try{return await this.closing;}finally{this.closing=null;}}
 async closeOwned(){if(this.shareChild){const child=this.shareChild;await new Promise(r=>{child.once('close',r);child.kill('SIGTERM');});}const s=this.session;if(!s)return;this.session=null;if(!s.exited){s.child.kill('SIGTERM');const timer=setTimeout(()=>{try{if(process.platform!=='win32')process.kill(-s.child.pid,'SIGKILL');else s.child.kill('SIGKILL');}catch{}},5000);await s.closed;clearTimeout(timer);}fs.rmSync(s.dir,{recursive:true,force:true});}
}
module.exports={XhsWebAdapter,nativeRequest,checkpoint,error};
