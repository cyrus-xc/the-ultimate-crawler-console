'use strict';
const fs=require('node:fs'),path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const VERSION='ui_locator_v1';
const text=n=>String(n.text||n['content-desc']||'').trim();
const stableId=n=>{const id=n['resource-id']||'';return id && !/obfuscated|0_resource_name/.test(id)?id:null;};
const ROLES={
 'search.open':{labels:['搜索','Search','검색']},
 'search.input':{classSuffix:'EditText'},
 'search.query':{structural:'search_query'},
 'sort.open':{labels:['全部','筛选','排序','综合','Sort','Filter']},
 'filter.quick_general':{labels:['综合']},
 'sort.reset':{labels:['重置','Reset']},
 'sort.general':{labels:['综合','综合排序']},
 'sort.time_descending':{labels:['最新']},
 'sort.popularity_descending':{labels:['最多点赞']},
 'sort.comment_descending':{labels:['最多评论']},
 'sort.collect_descending':{labels:['最多收藏']}
};
class LocatorError extends Error{constructor(code,role){super(code);this.code=code;this.role=role;}}
class UiLocator {
 constructor({serial,appVersion,root=null,now=Date.now}={}) {
  if(!serial||!appVersion)throw new Error('Device and App version required');
  this.now=now;this.scope=createHash('sha256').update(serial+'\0'+appVersion).digest('hex');this.file=root?path.join(root,this.scope+'.json'):null;
  this.bindings={};
  if(this.file){try{const saved=JSON.parse(fs.readFileSync(this.file,'utf8'));if(saved.version===VERSION&&saved.scope===this.scope)this.bindings=saved.bindings||{};}catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}}
 }
 matches(role,node,nodes=[]){
  const spec=ROLES[role];if(!spec)throw new LocatorError('UNKNOWN_CONTROL_ROLE',role);
  if(spec.structural==='search_query'){
    const clear=nodes.filter(n=>text(n)==='全部删除'&&n.center),submit=nodes.filter(n=>text(n)==='搜索'&&n.center),back=nodes.filter(n=>text(n)==='返回'&&n.center);
    if(clear.length!==1||submit.length!==1||back.length!==1||!node.center)return false;
    const y=submit[0].center[1],tolerance=Math.max(20,(submit[0].height||40)/2);
    return node.clickable==='true' && /TextView$/.test(node.class||'') && !!text(node) && node.center[0]>back[0].center[0] && node.center[0]<clear[0].center[0] && Math.abs(node.center[1]-y)<tolerance && Math.abs(clear[0].center[1]-y)<tolerance && Math.abs(back[0].center[1]-y)<tolerance;
  }
  return !!node.center && node.enabled!=='false' && (spec.labels?spec.labels.includes(text(node)):(node.class||'').endsWith(spec.classSuffix));
 }
 locate(role,nodes){
  let matches=nodes.filter(n=>this.matches(role,n,nodes));
  if(role==='sort.open'){for(const preferred of ROLES[role].labels){const group=matches.filter(n=>text(n)===preferred);if(group.length){matches=group;break;}}}
  else if(role.startsWith('sort.')||role==='filter.quick_general'){
    const anchors=nodes.filter(n=>['最多点赞','最多评论','最多收藏'].includes(text(n))&&n.center);
    if(anchors.length){const top=Math.min(...anchors.map(n=>n.center[1]));matches=matches.filter(n=>role==='filter.quick_general'?n.center[1]<top-Math.max(20,(n.height||40)/2):n.center[1]>=top-Math.max(20,(n.height||40)/2));}
  }
  // A cached resource ID is a hint, never sufficient proof if semantics changed.
  // Duplicate matches cannot be resolved by the old coordinate alone.
  if(matches.length!==1)throw new LocatorError(matches.length?'UI_CONTROL_AMBIGUOUS':'UI_CONTROL_NOT_FOUND',role);
  const node=matches[0],prior=this.bindings[role];
  const signature={resource_id:stableId(node),label:ROLES[role].labels?text(node):null,class:node.class||null};
  return {role,node,signature,context:nodes,recovered:!!prior&&JSON.stringify(prior.selector)!==JSON.stringify(signature),version:VERSION};
 }
 confirm(candidate,proof){
  if(!candidate||candidate.version!==VERSION||!this.matches(candidate.role,candidate.node,candidate.context))throw new LocatorError('INVALID_CONTROL_CANDIDATE',candidate?.role);
  if(!['search_input_visible','search_text_verified','response_sort_verified'].includes(proof))throw new LocatorError('CONTROL_POSTCONDITION_REQUIRED',candidate.role);
  const valid=['search.open','search.query'].includes(candidate.role)?proof==='search_input_visible':candidate.role==='search.input'?proof==='search_text_verified':candidate.role.startsWith('sort.')&&proof==='response_sort_verified';
  if(!valid)throw new LocatorError('CONTROL_POSTCONDITION_MISMATCH',candidate.role);
  this.bindings[candidate.role]={selector:candidate.signature,verified_at:this.now(),proof,revision:(this.bindings[candidate.role]?.revision||0)+1};
  if(this.file){fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700});const temp=this.file+'.'+randomUUID()+'.tmp';try{fs.writeFileSync(temp,JSON.stringify({version:VERSION,scope:this.scope,bindings:this.bindings}),{mode:0o600,flag:'wx'});fs.renameSync(temp,this.file);}finally{try{fs.unlinkSync(temp);}catch(e){if(e.code!=='ENOENT')throw e;}}}
  return {role:candidate.role,recovered:candidate.recovered,revision:this.bindings[candidate.role].revision};
 }
}
module.exports={UiLocator,LocatorError,ROLES,VERSION};
