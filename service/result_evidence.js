'use strict';
// Persist platform bodies once. Operational cursors/decisions remain in Store.
const fail=code=>Object.assign(Error(code),{code,status:409,scope:'item'});
function locate(root,target,prefix=''){
 if(root===target)return prefix;
 if(root&&typeof root==='object')for(const [key,value] of Object.entries(root)){
  const found=locate(value,target,prefix+'/'+key.replace(/~/g,'~0').replace(/\//g,'~1'));
  if(found!==null)return found;
 }
 return null;
}
function nativeProjection(value){
 if(Array.isArray(value))return value.map(nativeProjection);
 return value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>key!=='_native_original').map(([key,item])=>[key,nativeProjection(item)])):value;
}
function observed(stamp){if(typeof stamp==='string')return stamp;if(typeof stamp==='number'&&Number.isFinite(stamp)){try{return new Date(stamp*1000).toISOString();}catch{}}return null;}
function persistResult(store,claim,value){
 const input=value.data;if(!input||typeof input!=='object'||Array.isArray(input))return value;
 const data={...input},target=claim.target||{},subject={};
 if(typeof target.user_id==='string')subject.uid=target.user_id;
 if(typeof target.post_id==='string')subject.note_id=target.post_id;
 const capture=(body,{endpoint,stamp,kind}={})=>store.capture(Buffer.from(JSON.stringify(body),'utf8'),{
  platform:claim.payload.platform,kind:kind||claim.payload.operation,subject,
  observed_at:observed(stamp??input.observed_at??value.observed_at),
  source:{provider:'crawler_queue',...(claim.session_id?{session_id:claim.session_id}:{request_id:claim.request_id}),...(endpoint?{endpoint:endpoint.split('?')[0]}:{})},outcome:'success'});
 if(Object.hasOwn(data,'response')){
  // Native response is the original. `raw` is its detached normalized view.
  const response=data.response,ref=capture(response);
  data.response_ref=ref;delete data.response;
  if(data.raw&&typeof data.raw==='object'){
   data.raw=nativeProjection(data.raw);
   if(Object.hasOwn(input.raw,'native_profile')){
    const pointer=locate(response,input.raw.native_profile);
    if(pointer===null)throw fail('RAW_REF_SUBJECT_MISSING');
    delete data.raw.native_profile;data.raw.native_profile_ref={...ref,pointer};
   }
  }
  if(Array.isArray(data.native_evidence))data.native_evidence=data.native_evidence.map(e=>({...e,raw_ref:ref}));
 }else if(Object.hasOwn(data,'raw')){
  data.raw_ref=capture(data.raw);delete data.raw;
 }
 if(input.profile_end_observation&&typeof input.profile_end_observation==='object'){
  const observation=input.profile_end_observation,raw_ref=capture(observation,{kind:'profile.end.observation'});
  data.profile_end_observation={...Object.fromEntries(['schema','policy','terminal_decision','terminal_evidence','unavailable_reason'].filter(key=>Object.hasOwn(observation,key)).map(key=>[key,observation[key]])),
   ...(typeof observation.dom_snapshot?.truncated==='boolean'?{truncated:observation.dom_snapshot.truncated}:{}),raw_ref};
 }
 if(claim.payload.operation==='link.resolve'&&input.body&&typeof input.body==='object'){
  for(const key of ['resolved_url','post_id','user_id'])if(typeof input.body[key]==='string')data[key]=input.body[key];
 }
 if(Array.isArray(data.records)){
  data.records=data.records.map(record=>{
   if(!record||typeof record!=='object'||!Object.hasOwn(record,'body'))throw fail('RAW_RESPONSE_BODY_REQUIRED');
   const {body,...metadata}=record;
   return {...metadata,raw_ref:capture(body,{endpoint:record.endpoint,stamp:record.captured_at,kind:record.endpoint})};
  });
  // These are duplicates of the exact bodies in records, not a second source.
  delete data.body;delete data.items;
 }
 return {...value,data};
}
module.exports={persistResult};
