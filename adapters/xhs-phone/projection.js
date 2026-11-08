'use strict';
// Field aliases mirror native_phone_evidence_v4. Null is unknown, never zero.
const first=(o,...keys)=>{for(const k of keys)if(o?.[k]!==undefined&&o[k]!==null&&o[k]!=='')return o[k];return null;};
const redact=(x,key='')=>Array.isArray(x)?x.map(v=>redact(v)):x&&typeof x==='object'?Object.fromEntries(Object.entries(x).map(([k,v])=>[k,/token|cookie|authorization|session|shield|password|credential|secret|signature|^sign$|^sid$/i.test(k)?'[REDACTED]':redact(v,k)])):x;
function note(raw){
 const r=raw.note||raw.note_card||raw,m=r.interact_info||r.interactInfo||r,u=r.user||r.user_info||r.author||{};
 const sticky=first(r,'is_top','is_pinned','sticky')??first(m,'sticky','is_top'),tags=r.hash_tag||r.tag_info||r.tag_list||[];
 return {noteId:String(first(r,'id','note_id','noteId')||''),type:first(r,'type','note_type'),title:first(r,'title','display_title')||'',displayTitle:first(r,'title','display_title')||'',desc:first(r,'desc','description')||'',time:first(r,'time','create_time','timestamp'),lastUpdateTime:first(r,'last_update_time','update_time'),user:{userId:String(first(u,'userid','user_id','userId','id')||''),nickname:first(u,'nickname','nick_name','name')||'',avatar:first(u,'images','image','avatar')||''},ipLocation:first(r,'ip_location','ipLocation'),interactInfo:{likedCount:first(m,'liked_count','likes','likedCount'),collectedCount:first(m,'collected_count','collectedCount','collect_count'),commentCount:first(m,'comments_count','comment_count','commentCount'),shareCount:first(m,'shared_count','share_count','shareCount'),sticky},imageList:r.images_list||r.image_list||r.images||[],video:r.video_info_v2||r.video||{},tagList:(Array.isArray(tags)?tags:[]).filter(t=>t&&typeof t==='object').map(t=>({name:t.name??null})),poi:r.poi||r.poi_info||{},_native_original:redact(r)};
}
const count=v=>v===null||v===undefined||typeof v==='boolean'||String(v).trim()===''?null:Number.isSafeInteger(Number(v))&&Number(v)>=0?Number(v):null;
function listObservation(record,provenance){
 const n=note(record),m=n.interactInfo;let time=n.time;
 if(typeof time==='boolean'||time===null)time=null;
 else if(typeof time==='number'||/^\d+$/.test(String(time)))time=Number(time)>1e12?Number(time)/1000:Number(time);
 else time=Number.isFinite(Date.parse(time))?Date.parse(time)/1000:null;
 return {source_type:'xhs_native_app_user_posted',note_id:n.noteId,user_id:n.user.userId||null,author_user_id:n.user.userId||null,create_time:time,liked_count:count(m.likedCount),collected_count:count(m.collectedCount),comment_count:count(m.commentCount),shared_count:count(m.shareCount),collected_at:provenance.observed_at,is_pinned:typeof m.sticky==='boolean'?m.sticky:null,native_evidence:[provenance]};
}
function card(r){const n=note(r);return {id:n.noteId,modelType:'note',noteCard:n};}
function comment(r){const u=r.user||r.user_info||{};return {id:first(r,'id','comment_id'),content:first(r,'content','text')||'',userInfo:{userId:first(u,'userid','user_id','id'),nickname:u.nickname??null},likeCount:first(r,'like_count','liked_count'),createTime:first(r,'time','create_time'),ipLocation:r.ip_location??null,subCommentCount:first(r,'sub_comment_count','sub_comments_count'),subComments:(r.sub_comments||[]).filter(x=>x&&typeof x==='object').map(comment),_native_original:redact(r)};}
function items(payload,...keys){
 if(Array.isArray(payload))return payload.flatMap(r=>!r||typeof r!=='object'?[]:keys.some(k=>Array.isArray(r[k]))?items(r[keys.find(k=>Array.isArray(r[k]))],...keys):[r]);
 for(const k of keys)if(Array.isArray(payload?.[k]))return payload[k].filter(x=>x&&typeof x==='object');return [];
}
function envelope(result,operation,target){
 const p=result.response?.data||{},observed_at=new Date(result.captured_at_ms).toISOString();
 const evidence={operation:result.response_operation||result.operation,observed_at,trigger:'ui',transport_evidence:result.transport_evidence,request:redact(result.request)};
 const data={raw:{},native_evidence:[evidence],observed_at,end_observed:p.has_more===false,stop_reason:p.has_more===false?'native_end_observed':'native_page_limit',native_operation:result.response_operation||result.operation,response:result.response,request:result.request};
 if(operation==='post.detail'){
  const found=items(p,'note_list','notes','items').filter(r=>note(r).noteId===target.post_id);if(found.length!==1)throw Object.assign(Error('NATIVE_NOTE_IDENTITY_MISMATCH'),{code:'NATIVE_NOTE_IDENTITY_MISMATCH',scope:'item'});
  const raw=found[0];if(!('desc'in raw||'description'in raw))throw Object.assign(Error('NATIVE_DETAIL_BODY_UNOBSERVED'),{code:'NATIVE_DETAIL_BODY_UNOBSERVED',scope:'item'});
  data.raw={note:note(raw),comments:{list:[]}};data.comments_complete=false;data.end_observed=false;data.stop_reason='not_requested';data.share_status='unavailable';
  const link=raw.share_info?.link;try{const u=new URL(link);if(['www.xiaohongshu.com','xiaohongshu.com'].includes(u.hostname)&&u.protocol==='https:'&&new RegExp('/(?:explore|discovery/item)/'+target.post_id+'/?$').test(u.pathname)&&u.searchParams.get('xsec_token')&&!/REDACTED/i.test(u.searchParams.get('xsec_token'))){data.share_url=link;data.share_status='observed';}}catch{}
 }else if(operation==='profile.get'){
  const profile=p.user||p.user_info||p,id=String(first(profile,'userid','user_id','id')||'');if(id!==target.user_id)throw Object.assign(Error('NATIVE_USER_IDENTITY_MISMATCH'),{code:'NATIVE_USER_IDENTITY_MISMATCH',scope:'item'});
  data.raw={profile_user_id:id,native_profile:profile,profile:{basicInfo:{nickname:first(profile,'nickname','name')||'',desc:profile.desc||''},interactions:[]},feeds:[]};data.end_observed=true;
 }else if(operation==='post.comments')data.raw={comments:{list:items(p,'comments','comment_list','items').map(comment)}};
 else {
  const records=items(p,'items','notes','note_list');data.raw={feeds:records.map(card)};
  if(operation==='profile.posts'){
   data.raw.profile_user_id=target.user_id;data.native_list_observations=Object.fromEntries(records.map(r=>[note(r).noteId,listObservation(r,evidence)]));data.unread_notes=[];
  }
 }
 return {success:true,provider:'native_phone',transport:'native_phone',observed_at,data};
}
module.exports={first,note,card,comment,items,envelope,redact,listObservation};
