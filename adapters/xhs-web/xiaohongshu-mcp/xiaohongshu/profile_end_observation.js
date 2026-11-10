(uid) => {
 const clean=value=>String(value??'').replace(/https?:\/\/\S+/gi,'<URL>').replace(/\b(?:xsec_token|access_token|refresh_token|authorization|api[_-]?key)\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/gi,'<REDACTED>').replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,'<REDACTED>').replace(/[\x00-\x08\x0b-\x1f\x7f]/g,'').slice(0,200);
 const unwrap=value=>value?.value!==undefined?value.value:value?._value!==undefined?value._value:value;
 const visible=element=>{
  const box=element.getBoundingClientRect(),style=getComputedStyle(element);
  return style.display!=='none'&&style.visibility!=='hidden'&&box.width>0&&box.height>0&&box.bottom>0&&box.right>0&&box.top<innerHeight&&box.left<innerWidth;
 };
 const path=element=>{
  const parts=[];
  for(let node=element;node&&parts.length<5;node=node.parentElement){
   const tag=node.tagName.toLowerCase(),classes=[...node.classList].filter(name=>/^[a-zA-Z_-][a-zA-Z0-9_-]{0,60}$/.test(name)).slice(0,3);
   const siblings=node.parentElement?[...node.parentElement.children].filter(item=>item.tagName===node.tagName):[node];
   parts.unshift(tag+classes.map(name=>'.'+name).join('')+':nth-of-type('+(siblings.indexOf(node)+1)+')');
  }
  return parts.join(' > ').slice(0,400);
 };
 const state=window.__INITIAL_STATE__?.user||{},active=unwrap(state.activeTab)||{};
 const cards=[...document.querySelectorAll('section.note-item')].map(element=>{
  const href=element.querySelector('a.cover')?.getAttribute('href')||'';
  const match=href.match(/\/([a-fA-F0-9]{24})(?:[/?#]|$)/);
  return match?{element,note_id:match[1]}:null;
 }).filter(Boolean);
 const last=cards.at(-1),tail_nodes=[],seen=new Set();
 for(let anchor=last?.element,depth=0;anchor&&depth<3;anchor=anchor.parentElement,depth++){
  for(let node=anchor.nextElementSibling;node&&tail_nodes.length<6;node=node.nextElementSibling){
   if(seen.has(node)||!visible(node))continue;
   seen.add(node);const text=clean(node.innerText);
   if(text)tail_nodes.push({css_path:path(node),text});
  }
 }
 const loading_nodes=[...document.querySelectorAll('[aria-busy="true"],[role="progressbar"]')].filter(visible).slice(0,10)
  .map(element=>({css_path:path(element),aria_busy:element.getAttribute('aria-busy'),role:element.getAttribute('role')}));
 const state_loading={};
 for(const [key,value] of Object.entries(state)){
  const actual=unwrap(value);
  if(/^[a-zA-Z_][a-zA-Z0-9_]{0,60}$/.test(key)&&/loading|fetching|pending/i.test(key)&&typeof actual==='boolean')state_loading[key]=actual;
 }
 return JSON.stringify({schema:'xhs_profile_end_observation_v1',policy:'observed_terminal_v1',terminal_decision:'unverified',
  profile_uid_matches:location.pathname.replace(/\/$/,'')==='/user/profile/'+uid,
  active_tab:{index:Number.isInteger(active.index)?active.index:null,query:['note','fav','liked'].includes(active.query)?active.query:null},
  identified_card_count:cards.length,visible_identified_card_count:cards.filter(card=>visible(card.element)).length,
  last_card:last?{note_id:last.note_id,css_path:path(last.element),visible:visible(last.element)}:null,
  tail_nodes,loading_nodes,state_loading});
}
