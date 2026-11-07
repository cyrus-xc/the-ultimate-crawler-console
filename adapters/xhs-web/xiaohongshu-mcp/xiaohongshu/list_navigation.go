package xiaohongshu

// State belongs to one browser document; URLs stay private in that page.
const NoteNavigationVersion = "xhs_note_navigation_v2"

type noteNavigation struct {
	listDocument    float64
	Version         string `json:"version"`
	OpenMethod      string `json:"open_method"`
	ProfileLoads    int    `json:"profile_loads"`
	CardScrolls     int    `json:"card_scrolls"`
	CloseMethod     string `json:"close_method"`
	ListRestored    bool   `json:"list_restored"`
	DocumentChanged bool   `json:"document_changed"`
}

const rememberListJS = `() => {
 const cards=[...document.querySelectorAll('section.note-item a.cover')];
 if(!cards.length || !/^\/(user\/profile|search_result)/.test(location.pathname)) return false;
 const elements=new Set([document.scrollingElement]);
 for(let e=cards[0];e;e=e.parentElement) if(e.scrollHeight>e.clientHeight)elements.add(e);
 window.__xhsCrawlerList={url:location.href,document:performance.timeOrigin,
  positions:[...elements].filter(Boolean).map(e=>({e,top:e.scrollTop,left:e.scrollLeft}))};
 return true;
}`

const restoreListJS = `() => {
 const s=window.__xhsCrawlerList;
 if(!s || s.document!==performance.timeOrigin || new URL(s.url).pathname!==location.pathname) return false;
 for(const p of s.positions) if(p.e.isConnected)p.e.scrollTo({top:p.top,left:p.left,behavior:'instant'});
 return s.positions.length>0 && s.positions.every(p=>p.e.isConnected&&Math.abs(p.e.scrollTop-p.top)<2&&Math.abs(p.e.scrollLeft-p.left)<2);
}`

const visibleNoteJS = `() => {
 const visible=e=>!!(e&&e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none');
 return [...document.querySelectorAll('.note-detail-mask,#noteContainer,.note-container')].some(visible);
}`

const closeNoteControlJS = `() => {
 const visible=e=>{
  if(!e||!e.getClientRects().length||getComputedStyle(e).visibility==='hidden'||getComputedStyle(e).display==='none')return false;
  const r=e.getBoundingClientRect();
  return r.width>0&&r.height>0&&r.left+r.width/2>=0&&r.top+r.height/2>=0&&r.left+r.width/2<innerWidth&&r.top+r.height/2<innerHeight;
 };
 const root=[...document.querySelectorAll('.note-detail-mask,#noteContainer,.note-container')].find(visible);
 if(!root)return null;
 const selector='.close-circle,.close-button,.close-icon,[aria-label="关闭"],[aria-label="Close"],[title="关闭"],[title="Close"]';
 // The page also has a right-hand panel close icon outside the viewport.
 // Selecting that first makes Rod scroll/click the wrong panel. Prefer the
 // note's native circle X; never scroll the list to reveal another close icon.
 return [...root.querySelectorAll('.close-circle'),...document.querySelectorAll('.close-circle'),...root.querySelectorAll(selector)].find(visible)||null;
}`

// Use the site's router for fallback. Ordinary injected hyperlinks load a
// new document and destroy the author grid beneath the note.
const routerNoteJS = `async (id,tok) => {
 let router=document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$router;
 if(!router)for(const e of document.querySelectorAll('section.note-item,#app')){
  for(let c=e.__vueParentComponent;c;c=c.parent){router=c.appContext?.config?.globalProperties?.$router;if(router)break;}
  if(router)break;
 }
 if(!router?.push)return 'unavailable';
 await router.push({path:'/explore/'+id,query:{xsec_token:tok,xsec_source:location.pathname.startsWith('/user/profile/')?'pc_user':'pc_search'}});
 return 'clicked';
}`

const returnToListJS = `() => {
 const s=window.__xhsCrawlerList;
 if(!s || s.document!==performance.timeOrigin || new URL(s.url).pathname===location.pathname) return false;
 if(!location.pathname.startsWith('/explore/')) return false;
 history.back();return true;
}`

// Virtualized grids may discard cards above the viewport. Locate the target
// in the loaded inventory instead of assuming the next request is lower.
const seekNoteJS = `(id) => {
 const links=[...document.querySelectorAll('section.note-item a.cover')];
 const unwrap=x=>x?.value??x?._value??x;
 const u=window.__INITIAL_STATE__?.user;
 const feeds=location.pathname.startsWith('/user/profile/')?
  (unwrap(u?.notes)?.[unwrap(u?.activeTab)?.index||0]||[]):(unwrap(window.__INITIAL_STATE__?.search?.feeds)||[]);
 const ids=feeds.map(x=>x.id||x.noteId||x.noteCard?.noteId);
 const target=ids.indexOf(id);
 const visible=links.filter(a=>{const r=a.getBoundingClientRect();return r.bottom>0&&r.top<innerHeight});
 const first=visible[0]||links[0];
 if(!first)return 900;
 const current=ids.findIndex(n=>n&&(first.getAttribute('href')||'').includes(n));
 if(target<0||current<0)return 900;
 const rect=first.closest('section.note-item').getBoundingClientRect();
 const cols=Math.max(1,visible.filter(a=>Math.abs(a.getBoundingClientRect().top-first.getBoundingClientRect().top)<20).length);
 return Math.max(-12000,Math.min(12000,(target-current)/cols*Math.max(rect.height,100))) || 900;
}`
