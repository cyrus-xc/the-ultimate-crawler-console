'use strict';
// A discovery conversation owns one physical device across its two HTTP rounds.
// It never submits work behind its own external lease.
const {randomUUID}=require('node:crypto');
const {problem}=require('./contract');
const ID=/^[a-f0-9]{24}$/i;
const fail=(code,status=409)=>problem(code,status);
function timestamp(value){
 if(value===null||value===undefined||value===''||typeof value==='boolean')return null;
 if(typeof value==='number'||/^\d+$/.test(String(value))){const n=Number(value);return n>0&&Number.isFinite(n)?(n<1e12?n*1000:n):null;}
 const n=Date.parse(value);return Number.isFinite(n)?n:null;
}
function dateInput(value){if(typeof value!=='string'||!/(?:Z|[+-]\d\d:\d\d)$/.test(value)||timestamp(value)===null)throw fail('INVALID_DISCOVERY_DATE',400);return timestamp(value);}
function normalize(input,now){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['schema_version','platform','user_id','routing','mode','count','startdate','enddate','timeout_seconds'].includes(k)))throw fail('INVALID_DISCOVERY_REQUEST',400);
 if(input.schema_version!=='crawler.discovery.v1'||input.platform!=='xiaohongshu'||!ID.test(input.user_id||''))throw fail('INVALID_DISCOVERY_REQUEST',400);
 const q={...input,routing:{kinds:['web','android'],device_ids:[],...input.routing},timeout_seconds:input.timeout_seconds??7200};
 if(!Number.isInteger(q.timeout_seconds)||q.timeout_seconds<30||q.timeout_seconds>86400)throw fail('INVALID_DISCOVERY_TIMEOUT',400);
 if(Object.keys(q.routing).some(k=>!['kinds','device_ids'].includes(k))||!Array.isArray(q.routing.kinds)||!q.routing.kinds.length||q.routing.kinds.some(x=>!['web','android'].includes(x))||!Array.isArray(q.routing.device_ids)||q.routing.device_ids.some(x=>typeof x!=='string'||!x))throw fail('INVALID_ROUTING',400);
 if(q.mode==='count'){if(!Number.isInteger(q.count)||q.count<1||q.count>1000||q.startdate!==undefined||q.enddate!==undefined)throw fail('INVALID_DISCOVERY_MODE',400);}
 else if(q.mode==='date'){if(q.count!==undefined)throw fail('INVALID_DISCOVERY_MODE',400);q.start=dateInput(q.startdate);q.end=q.enddate===undefined?now:dateInput(q.enddate);if(q.start>q.end)throw fail('INVALID_TIME_RANGE',400);}
 else throw fail('INVALID_DISCOVERY_MODE',400);
 return q;
}
function booleanEvidence(value){if(value===true||value===1||value==='1')return true;if(value===false||value===0||value==='0')return false;return null;}
function imageUrl(value){
 if(typeof value==='string')return /^https?:\/\//.test(value)?value:null;
 if(!value||typeof value!=='object')return null;
 for(const key of ['urlDefault','url_default','url','url_size_large','urlSizeLarge','urlPre','url_pre'])if(typeof value[key]==='string'&&/^https?:\/\//.test(value[key]))return value[key];
 for(const item of value.infoList||value.info_list||[]){const url=imageUrl(item);if(url)return url;}
 return null;
}
function card(raw,index){
 const r=raw.noteCard||raw.note_card||raw,n=r._native_original||{};
 const id=String(raw.id||raw.noteId||raw.note_id||r.noteId||r.note_id||'');if(!ID.test(id))return null;
 const sticky=r.interactInfo?.sticky??r.interact_info?.sticky??r.is_pinned??r.is_top??n.is_top??n.is_pinned??n.sticky;
 const t=timestamp(r.time??r.create_time??r.timestamp??n.time??n.create_time??n.timestamp);
 const bodyRecord=r._native_original||r;const excerpt=['desc','description','body','content'].map(key=>bodyRecord[key]).find(value=>typeof value==='string'&&value.trim());
 const images=[r.cover,n.cover,...(Array.isArray(r.imageList)?r.imageList:[]),...(Array.isArray(n.images_list)?n.images_list:[]),...(Array.isArray(n.image_list)?n.image_list:[])];
 return {note_id:id,note_type:r.type??r.note_type??n.type??n.note_type??null,title:r.displayTitle||r.display_title||r.title||'',body:excerpt??null,body_observed:excerpt!==undefined,body_source:excerpt===undefined?null:'profile_excerpt',cover_url:images.map(imageUrl).find(Boolean)||null,published_at:t===null?null:new Date(t).toISOString(),is_pinned:booleanEvidence(sticky),observed_url:null,index,_raw:raw};
}
function detailNote(data,id){const raw=data?.raw||{},map=raw.noteDetailMap||{};return raw.note||raw[id]?.note||map[id]?.note||raw[id]||raw;}
class DiscoverySessions {
 constructor({store,adapters,gateway=null,now=()=>Date.now(),heartbeatMs}={}){this.store=store;this.adapters=adapters;this.gateway=gateway;this.now=now;this.sessions=new Map();this.heartbeatMs=heartbeatMs||Math.max(10,Math.floor(store.leaseMs/3));}
 guard(s){if(s.controller.signal.aborted)throw s.controller.signal.reason;if(this.now()>=s.deadline)throw fail('DISCOVERY_SESSION_EXPIRED');this.store.assertLease(s.lease,{externalOnly:true});if(this.store.devices().find(d=>d.id===s.device_id)?.quarantined)throw fail('DEVICE_QUARANTINED');}
 async run(s,operation,target,params={}){
  this.guard(s);const values=[],claim={device_id:s.device_id,lease:s.lease,target,payload:{platform:'xiaohongshu',operation,params,limits:{max_pages:100,execution_timeout_seconds:Math.max(1,Math.ceil((s.deadline-this.now())/1000))},cache:{mode:'refresh'},continuation:{mode:'automatic'}}};
  const context={discovery:s.kind==='web'?undefined:s.navigation,claim,resume:{seen_ids:[],binding:s.id,cursor:null},signal:s.controller.signal,guard:()=>this.guard(s),input:async fn=>{this.guard(s);return fn();},commit:page=>{this.guard(s);for(const item of page.items||[])values.push(item.value);},waitForDecision:async()=>{this.guard(s);return 'continue';}};
  try{await s.adapter.execute(context);this.guard(s);return values;}catch(error){if(/^[A-Z][A-Z0-9_]{0,100}$/.test(error.code||''))error.status=error.status||409;
   if(error.diagnostics){const d=error.diagnostics;error.discovery_diagnostics={operation,exception_type:typeof d.exception_type==='string'&&/^[A-Za-z_]+$/.test(d.exception_type)?d.exception_type:null,stage:['configuration','attachment','capture'].includes(d.stage)?d.stage:null,selected_note_type:s.navigation.card?._raw?.noteCard?.type??null,expected_path:d.expected_path??null,expected_method:d.expected_method??null,events:Object.fromEntries(Object.entries(d.events||{}).filter(([k,v])=>/^[a-z_]+$/.test(k)&&Number.isFinite(v))),observed_requests:(d.observed_requests||[]).slice(0,20).map(r=>({path:typeof r.path==='string'?r.path.split('?')[0]:null,host:typeof r.host==='string'&&/^[a-zA-Z0-9.-]+$/.test(r.host)?r.host:null,method:['GET','POST','PUT','HEAD'].includes(r.method)?r.method:null,status:r.status??null,response_shape:r.response_shape??null,target_id_paths:r.target_id_paths??[],query_names:(r.query_names||[]).filter(k=>typeof k==='string'&&/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)),note_id_query_matches:r.note_id_query_matches===true,response_note_identity_matches:r.response_note_identity_matches===true,requested_page_match:r.requested_page_match===true,target_match_without_pagination:r.target_match_without_pagination===true}))};}
   if(s.navigation.trace?.length)error.discovery_diagnostics={...(error.discovery_diagnostics||{operation}),navigation_trace:s.navigation.trace.slice(-20)};
   throw error;}
 }
 async probe(s,c){
  if(s.dates.has(c.note_id))return s.dates.get(c.note_id);
  s.navigation.card=c;const values=await this.run(s,'post.detail',{post_id:c.note_id},{native_request:{kind:'detail',id:c.note_id,user_id:s.query.user_id,target:1,seconds:45,comments:false}});
  const value=[...values].reverse().find(v=>v.data?.raw);if(!value)throw fail('DISCOVERY_DETAIL_UNOBSERVED');
  const note=detailNote(value.data,c.note_id),t=timestamp(note.time??note.create_time??note.timestamp);
  if(t===null)throw fail('DISCOVERY_DATE_UNOBSERVED');
  s.dates.set(c.note_id,t);s.probes.set(c.note_id,value.data);c.published_at=new Date(t).toISOString();c.published_at_source='detail';return t;
 }
 async date(s,c){const t=timestamp(c.published_at);return t===null?this.probe(s,c):t;}
 async boundary(s,cards,threshold){let low=0,high=cards.length;while(low<high){const mid=Math.floor((low+high)/2),t=await this.date(s,cards[mid]);if(t>threshold)low=mid+1;else high=mid;}return low;}
 async collect(s){
  let target=s.query.mode==='count'?s.query.count:20,reason='page_limit',complete=false;
  for(let batch=0;batch<50;batch++){
   const values=await this.run(s,'profile.posts',{user_id:s.query.user_id},{max_items:target,native_request:{...(s.kind==='web'?{kind:'profile',id:s.query.user_id}:{}),target,seconds:90,comments:false}});
   let end=false,newCount=0;
   for(const value of values){const data=value.data||{},raw=data.raw||{};for(const row of raw.feeds||[]){const c=card(row,s.cards.size);if(c)c.published_at_source=c.published_at?'profile_payload':null;if(c&&c.is_pinned===null&&Array.isArray(raw.dom_cards)){const d=raw.dom_cards.find(d=>String(d.href||'').includes(c.note_id));if(d&&typeof d.sticky==='boolean')c.is_pinned=d.sticky;}if(c){const previous=s.cards.get(c.note_id);if(!previous){s.cards.set(c.note_id,c);newCount++;}else{for(const key of ['is_pinned','published_at','published_at_source','cover_url'])if(previous[key]===null&&c[key]!==null)previous[key]=c[key];if(!previous.title&&c.title)previous.title=c.title;}}}
    if(value.phase==='result'){reason=data.stop_reason||reason;end ||= data.end_observed===true||reason==='native_end_observed';}}
   const all=[...s.cards.values()];s.navigation.cards=all;s.navigation.index=Math.max(0,all.length-1);
   if(s.query.mode==='count'){complete=all.length>=s.query.count;reason=complete?'target_loaded':reason;s.returned=all;break;}
   // Pinned cards are outside the chronological order, so probe independently.
   // Unknown pin state cannot establish an ordered boundary.
   if(all.some(c=>c.is_pinned===null))throw fail('DISCOVERY_PIN_STATE_UNOBSERVED');
   const ordered=all.filter(c=>!c.is_pinned),last=ordered.at(-1);
   const crossed=last&&(await this.date(s,last))<s.query.start;
   if(crossed||end){
    const first=await this.boundary(s,ordered,s.query.end),after=await this.boundary(s,ordered,s.query.start-1);
    const selected=ordered.slice(first,after);for(const c of all.filter(c=>c.is_pinned)){const t=await this.date(s,c);if(t>=s.query.start&&t<=s.query.end)selected.push(c);}
    s.returned=selected.sort((a,b)=>a.index-b.index);complete=true;reason=crossed?'date_boundary_reached':'profile_end';break;
   }
   if(!newCount||all.length>=1000){s.returned=[];reason=!newCount?'no_growth':'card_limit';break;}
   // Expand only the forward collection boundary; cached indices are used for
   // binary date probes, never represented as random access to unseen pages.
   target=Math.min(1000,Math.max(target+20,all.length+20));
  }
  if(!s.returned)s.returned=[];
  if(!complete&&s.query.mode==='date')throw fail('DISCOVERY_DATE_COVERAGE_INCOMPLETE');
  s.coverage={complete,stop_reason:reason,loaded_count:s.cards.size,returned_count:s.returned.length,date_probe_count:s.probes.size,order_assumption:'non_pinned_newest_first'};
 }
 async open(input,scope='pipeline',signal){
  const query=normalize(input,this.now()),payload={platform:'xiaohongshu',operation:'profile.posts',params:{},routing:query.routing};
  const devices=this.store.devices().filter(d=>!d.owner&&this.store.compatible(d,payload)&&this.store.healthy(d,payload)&&this.store.compatible(d,{...payload,operation:'post.detail'})&&this.adapters.get(d.id));
  if(!devices.length)throw fail('NO_AVAILABLE_DISCOVERY_DEVICE');
  const id=randomUUID(),device=devices[0],lease=this.store.externalLease(device.id,'discovery:'+scope+':'+id);
  const s={id,scope,device_id:device.id,kind:device.kind,adapter:this.adapters.get(device.id),query,lease,deadline:this.now()+query.timeout_seconds*1000,controller:new AbortController(),cards:new Map(),dates:new Map(),probes:new Map(),navigation:{cards:[],index:0},state:'collecting'};this.sessions.set(id,s);
  s.timer=setInterval(()=>{try{this.guard(s);this.store.heartbeat(s.lease);}catch(e){this.cancel(id,scope,e).catch(()=>{});}},this.heartbeatMs);s.timer.unref();
  const disconnect=()=>this.cancel(id,scope,fail('CLIENT_DISCONNECTED')).catch(()=>{});signal?.addEventListener('abort',disconnect,{once:true});
  s.work=this.collect(s);if(signal?.aborted)disconnect();
  try{await s.work;this.guard(s);s.state='awaiting_selection';return {schema_version:'crawler.discovery.v1',session_id:id,device_id:s.device_id,state:s.state,cards:s.returned.map(({_raw,...c})=>c),coverage:s.coverage,expires_at:new Date(s.deadline).toISOString()};}
  catch(error){await this.release(s).catch(()=>{});throw error;}finally{signal?.removeEventListener('abort',disconnect);}
 }
 get(id,scope){const s=this.sessions.get(id);if(!s||s.scope!==scope)throw fail('DISCOVERY_SESSION_NOT_FOUND',404);return s;}
 async complete(id,input,scope='pipeline'){
  const s=this.get(id,scope),ids=input?.selected_ids;
  if(!input||Object.keys(input).some(k=>k!=='selected_ids')||!Array.isArray(ids)||ids.length>3||new Set(ids).size!==ids.length||ids.some(v=>!s.returned?.some(c=>c.note_id===v)))throw fail('INVALID_DISCOVERY_SELECTION',400);
  if(s.state==='completed'){if(JSON.stringify(ids)!==JSON.stringify(s.selection))throw fail('DISCOVERY_SELECTION_CONFLICT');return s.result;}
  if(s.state!=='awaiting_selection')throw fail('DISCOVERY_SESSION_BUSY');this.guard(s);s.state='reading_details';s.selection=[...ids];
  s.work=(async()=>{const details=[];for(const id of ids){s.navigation.card=s.cards.get(id);const values=await this.run(s,'post.detail',{post_id:id},{native_request:{kind:'detail',id,user_id:s.query.user_id,target:1,seconds:45,comments:false,capture_share:true}});const value=[...values].reverse().find(v=>v.data?.raw);if(!value)throw fail('DISCOVERY_DETAIL_UNOBSERVED');details.push({note_id:id,data:value.data,...(s.kind==='android'?{navigation:s.navigation.trace||[]}: {})});}return details;})();
  try{const details=await s.work;await this.release(s);s.state='completed';return s.result={session_id:id,state:'completed',details,released:true};}
  catch(error){await this.release(s).catch(()=>{});throw error;}
 }
 async release(s){
  if(s.releasing)return s.releasing;
  s.controller.abort(fail('DISCOVERY_SESSION_CLOSED'));s.releasing=(async()=>{clearInterval(s.timer);try{await this.gateway?.drain(s.lease);if(s.kind==='web')await s.adapter.close?.();await this.gateway?.drain(s.lease);this.store.releaseExternal(s.lease);this.gateway?.forgetReleased?.(s.lease);s.state='released';s.cards.clear();s.probes.clear();s.dates.clear();s.navigation={};s.returned=s.returned?.map(({_raw,...c})=>c);const retention=setTimeout(()=>this.sessions.delete(s.id),300000);retention.unref();}
   catch(error){this.store.quarantine(s.device_id,'DISCOVERY_CLEANUP_FAILED');s.state='cleanup_failed';throw error;}})();return s.releasing;
 }
 async cancel(id,scope='pipeline',reason=fail('STOP_REQUESTED')){const s=this.get(id,scope);if(s.state==='completed'||s.state==='released')return {session_id:id,released:true};s.controller.abort(reason);let timer;try{await Promise.race([s.work?.catch(()=>{}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(fail('DISCOVERY_STOP_TIMEOUT')),10000);})]);}catch(error){clearInterval(s.timer);this.store.quarantine(s.device_id,'DISCOVERY_STOP_TIMEOUT');s.state='cleanup_failed';throw error;}finally{clearTimeout(timer);}await this.release(s);return {session_id:id,released:true};}
 async close(){await Promise.allSettled([...this.sessions.values()].filter(s=>!['completed','released'].includes(s.state)).map(s=>this.cancel(s.id,s.scope)));}
}
module.exports={DiscoverySessions,normalize,card,timestamp,detailNote,imageUrl,booleanEvidence};
