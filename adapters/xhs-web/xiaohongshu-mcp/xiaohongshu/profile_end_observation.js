(uid) => {
 const clean=value=>String(value??'').replace(/https?:\/\/\S+/gi,'<URL>').replace(/\b(?:xsec_token|access_token|refresh_token|authorization|api[_-]?key|cookie|password|client_secret)["']?\s*[:=]\s*["']?(?:Bearer\s+)?[^\s,;"']+/gi,'<REDACTED>').replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,'<REDACTED>').replace(/[\x00-\x08\x0b-\x1f\x7f]/g,'').slice(0,200);
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
  let link;
  try{link=new URL(href,location.href);}catch{return null;}
  if(link.origin!==location.origin)return null;
  const parts=link.pathname.split('/').filter(Boolean),id=parts.at(-1);
  const noteRoute=(parts.length===2&&parts[0]==='explore')||
   (parts.length===3&&parts[0]==='discovery'&&parts[1]==='item')||
   (parts.length===4&&parts[0]==='user'&&parts[1]==='profile'&&/^[a-fA-F0-9]{24}$/.test(parts[2]));
  return noteRoute&&/^[a-fA-F0-9]{24}$/.test(id)?{element,note_id:id,href_path:link.pathname}:null;
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
 const profileUIDMatches=location.pathname.replace(/\/$/,'')==='/user/profile/'+uid;
 const domSnapshot=()=>{
  const schema='xhs_profile_dom_snapshot_v1';
  if(!profileUIDMatches||active.query!=='note')return {schema,unavailable_reason:'PUBLISHED_PROFILE_SCOPE_UNCONFIRMED'};
  const container=last?.element.closest('.feeds-tab-container');
  if(!container)return {schema,unavailable_reason:'ACTIVE_PROFILE_LIST_UNOBSERVED'};
  const activeList=last.element.closest('.tab-content-item');
  if(!activeList||container.querySelectorAll('.tab-content-item')[active.index]!==activeList)
   return {schema,unavailable_reason:'ACTIVE_PROFILE_LIST_UNCONFIRMED'};
  const maxNodes=256,maxBytes=48*1024,maxDepth=12,encoder=new TextEncoder();
  let nodeCount=0,remaining=maxBytes-1024,truncated=false;
  const cardIDs=new Map(cards.map(card=>[card.element,card]));
  const capture=(node,depth)=>{
   if(nodeCount>=maxNodes||depth>maxDepth){truncated=true;return null;}
   const classes=[...node.classList],shown=visible(node),card=cardIDs.get(node);
   const value={tag:node.tagName.toLowerCase(),css_path:path(node),visible:shown};
   const children=[...node.children];
   // The active note list is the only tab whose text/children are retained.
   if(['script','style','template','input','textarea','select','option','iframe','object','embed'].includes(value.tag))value.omitted_content=true;
   else if(classes.includes('tab-content-item')&&node!==activeList)value.inactive_tab=true;
   else if(card){value.note_id=card.note_id;value.href_path=card.href_path;if(shown)value.text=clean(node.innerText);}
   else{
    if(shown&&!children.length){const text=clean(node.innerText);if(text)value.text=text;}
    const busy=node.getAttribute('aria-busy'),role=node.getAttribute('role');
    if(busy==='true'||busy==='false')value.aria_busy=busy;
    if(role==='progressbar')value.role=role;
    value.children=[];
   }
   const bytes=encoder.encode(JSON.stringify(value)).length+2;
   if(bytes>remaining){truncated=true;return null;}
   remaining-=bytes;nodeCount++;
   if(value.children)for(const child of children){const item=capture(child,depth+1);if(item)value.children.push(item);if(nodeCount>=maxNodes||remaining<32){truncated=true;break;}}
   return value;
  };
  // Save nearby outside-tail context first, so a large grid cannot consume
  // the budget before a sibling marker. This is observation, never a decision.
  const outsideTail=[];
  for(let node=container.nextElementSibling;node&&outsideTail.length<4;node=node.nextElementSibling){const item=capture(node,0);if(item)outsideTail.push(item);}
  const tree=capture(container,0),box=container.getBoundingClientRect();
  const bounds=Object.fromEntries(['top','bottom','left','right','width','height'].filter(key=>Number.isFinite(box[key])).map(key=>[key,Math.round(box[key]*10)/10]));
  return {schema,node_count:nodeCount,truncated,bounds,tree,outside_tail:outsideTail};
 };
 return JSON.stringify({schema:'xhs_profile_end_observation_v1',policy:'observed_terminal_v1',terminal_decision:'unverified',
  profile_uid_matches:profileUIDMatches,
  active_tab:{index:Number.isInteger(active.index)?active.index:null,query:['note','fav','liked'].includes(active.query)?active.query:null},
  identified_card_count:cards.length,visible_identified_card_count:cards.filter(card=>visible(card.element)).length,
  last_card:last?{note_id:last.note_id,href_path:last.href_path,css_path:path(last.element),visible:visible(last.element)}:null,
  tail_nodes,loading_nodes,state_loading,dom_snapshot:domSnapshot()});
}
