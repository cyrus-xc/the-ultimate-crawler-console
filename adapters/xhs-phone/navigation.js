'use strict';
const {DevicePause}=require('../../android/android_adb');
const {writeAndroidClipboard}=require('../../android/android_clipboard');
const {UiLocator,SORT_ANCHORS}=require('../../android/ui_locator');
const SORT_LABELS={general:'综合',time_descending:'最新',popularity_descending:'最多点赞',comment_descending:'最多评论',collect_descending:'最多收藏'};
const label=n=>String(n?.text||n?.['content-desc']||'').trim();
// Observed profile cards expose one clickable accessibility description, not
// necessarily an independent title node. Parse its bounded native structure.
function discoveryTitle(node){const value=label(node);const match=value.match(/^(?:视频|图文|笔记|图片),([\s\S]+),来自[\s\S]+,[\d.,万亿]+赞[，,]?$/);return match?match[1].trim():value;}
const failed=code=>{throw new DevicePause(code,code);};
function choose(nodes,predicate,code){const found=nodes.filter(predicate);if(found.length!==1)failed(code);return found[0];}
function isProfileUi(nodes){
 const labels=nodes.map(label);
 return labels.some(t=>/^(?:已选定)?笔记$|^(?:Selected )?Notes$|^노트$/i.test(t))
  &&labels.some(t=>/^粉丝$|^Followers$|^팔로워$|^小红书号[：:]|^RED ID[：:]/i.test(t));
}
function knownOplusWarning(nodes){
 const own=nodes.filter(n=>n.package==='com.oplus.battery');
 return own.some(n=>label(n)==='“小红书”异常')&&own.some(n=>label(n)==='“小红书”运行异常，建议前往软件商店更新至最新版本。');
}
// Dialogs with one known, harmless dismissal. Never accept an update/install.
const LATER=/^(?:稍后再说|以后再说|暂不更新|暂不升级)$/;
const KNOWN_DIALOGS=[
 {id:'oplus_battery_warning',match:knownOplusWarning,
  dismiss:n=>n.package==='com.oplus.battery'&&label(n)==='取消'&&n.class==='android.widget.Button'},
 {id:'xhs_update_prompt',
  match:nodes=>{const own=nodes.filter(n=>n.package==='com.xingin.xhs');
   return own.some(n=>/^(?:免流量升级|发现新版本|版本更新|立即升级|立即更新|立即安装)$/.test(label(n)))&&own.some(n=>LATER.test(label(n)));},
  dismiss:n=>n.package==='com.xingin.xhs'&&LATER.test(label(n))},
];
// Something other than the feed/grid is in front: a foreign window or an
// actionable prompt inside XHS. Used only after scrolling stopped changing UI.
function overlayIn(nodes){
 const foreign=nodes.find(n=>n.package&&!['com.xingin.xhs','com.android.systemui'].includes(n.package));
 if(foreign)return 'package:'+foreign.package;
 const prompt=nodes.find(n=>n.package==='com.xingin.xhs'&&/^(?:立即安装|立即升级|立即更新|去开启|允许|同意|我知道了|知道了|去设置|开启通知|去评分)$/.test(label(n)));
 return prompt?'prompt:'+label(prompt):null;
}
const fingerprint=nodes=>nodes.map(n=>label(n)).filter(Boolean).join('|');
const between=(random,min,max)=>min+random()*(max-min);

class XhsNavigation {
  constructor(adb,{guard,writeClipboard=writeAndroidClipboard,locator,clipboardPort,random=Math.random}={}) {
    if(typeof guard!=='function')throw new Error('Device lease guard required');
    this.adb=adb;this.guard=guard;this.writeClipboard=writeClipboard;this.random=random;
    this.clipboardPort=clipboardPort;this.locator=locator||new UiLocator({serial:adb.serial||'offline',appVersion:'unverified'});this.pendingSort=null;
  }
  async action(fn){await this.guard();return await fn();}
  async ui(){
    await this.guard();let nodes=await this.adb.ui();
    // Dismiss only listed dialogs through their unique harmless control (the
    // OnePlus battery warning's Cancel, XHS update's "later"). Never install or
    // update the App; unknown authentication/system dialogs are not handled here.
    for(let round=0;round<2;round++){
      const dialog=KNOWN_DIALOGS.find(d=>d.match(nodes));
      if(!dialog)return nodes;
      const control=choose(nodes,n=>dialog.dismiss(n)&&n.clickable==='true'&&n.enabled!=='false'&&n.center,'APP_WARNING_CANCEL_UNAVAILABLE');
      await this.tap(control);this.adb.logIncident?.({kind:'dialog_dismissed',dialog:dialog.id});
      await this.adb.wait(600);await this.guard();nodes=await this.adb.ui();
      if(dialog.match(nodes))failed('APP_WARNING_DISMISS_FAILED');
    }
    return nodes;
  }
  blocked(nodes){
    const overlay=overlayIn(nodes);
    this.adb.logIncident?.({kind:'ui_blocked',overlay,labels:nodes.map(label).filter(Boolean).slice(0,20)});
    failed(overlay?'UI_BLOCKED_BY_OVERLAY':'PHONE_PAGE_RESPONSE_UNOBSERVED');
  }
  async shell(...args){return this.action(()=>this.adb.shell(...args));}
  async tap(node){return this.action(()=>this.adb.tap(node));}
  async search(keyword,{submit=true}={}) {
    if(typeof keyword!=='string'||!keyword.trim()||keyword.length>200)failed('INVALID_KEYWORD');
    await this.shell('monkey','-p','com.xingin.xhs','-c','android.intent.category.LAUNCHER','1');
    let nodes=await this.ui();
    let edits=nodes.filter(n=>/EditText$/.test(n.class||''));
    if(!edits.length){
      let search;
      for(let depth=0;depth<5;depth++){
        try{search=this.locator.locate('search.query',nodes);}catch{}
        if(!search){try{search=this.locator.locate('search.open',nodes);}catch{}}
        if(search)break;
        // A prior detail/profile job may leave XHS away from its search entry.
        // Use bounded normal Back navigation, never guessed icon coordinates.
        if(depth===4||nodes.some(n=>['发现','Discover','Explore'].includes(label(n)))||nodes.some(n=>['搜索','Search','검색'].includes(label(n))))failed('SEARCH_CONTROL_UNAVAILABLE');
        await this.shell('input','keyevent','4');await this.adb.wait(350);nodes=await this.ui();
      }
      for(let attempt=0;attempt<2;attempt++){
        await this.tap(search.node);await this.adb.wait(350);nodes=await this.ui();
        if(nodes.some(n=>/EditText$/.test(n.class||''))){
          this.locator.locate('search.input',nodes);this.locator.confirm(search,'search_input_visible');break;
        }
        // An open filter sheet may consume the first click to dismiss itself.
        // Re-resolve the query from the new tree; never repeat stale coordinates.
        if(attempt===1)failed('SEARCH_INPUT_UNAVAILABLE');
        try{search=this.locator.locate('search.query',nodes);}catch{failed('SEARCH_INPUT_UNAVAILABLE');}
      }
    }
    choose(nodes,n=>/EditText$/.test(n.class||'')&&n.center,'SEARCH_INPUT_UNAVAILABLE');
    await this.action(()=>this.writeClipboard(this.adb,keyword,{port:this.clipboardPort}));
    await this.shell('monkey','-p','com.xingin.xhs','-c','android.intent.category.LAUNCHER','1');
    nodes=await this.ui();const inputCandidate=this.locator.locate('search.input',nodes),input=inputCandidate.node;
    await this.tap(input);await this.shell('input','keyevent','123');
    await this.shell('input','keyevent',...Array(Math.min(280,label(input).length+8)).fill('67'));
    await this.shell('input','keyevent','279');
    nodes=await this.ui();const actual=label(choose(nodes,n=>/EditText$/.test(n.class||'')&&n.center,'SEARCH_INPUT_UNAVAILABLE')).replace(/^(?:搜索|Search),\s*/i,'');
    if(actual!==keyword)failed('SEARCH_INPUT_MISMATCH');
    this.locator.confirm(inputCandidate,'search_text_verified');
    if(submit)await this.submitSearch();
  }
  async submitSearch(){await this.shell('input','keyevent','66');await this.adb.wait(500);}
  async sort(value){
    const wanted=SORT_LABELS[value];if(!wanted)failed('UNSUPPORTED_SORT');
    let nodes=await this.ui();
    if(nodes.some(n=>SORT_ANCHORS.includes(label(n)))){await this.shell('input','keyevent','4');await this.adb.wait(350);nodes=await this.ui();}
    let quick;try{quick=this.locator.locate('filter.quick_general',nodes);}catch{failed('QUICK_FILTER_RESET_UNAVAILABLE');}
    if(quick.node.selected!=='true'){await this.tap(quick.node);await this.adb.wait(350);nodes=await this.ui();}
    const expanded=nodes.some(n=>SORT_ANCHORS.includes(label(n)));
    if(!expanded){
      let opener;try{opener=this.locator.locate('sort.open',nodes);}catch{failed('SORT_CONTROL_UNAVAILABLE');}
      await this.tap(opener.node);await this.adb.wait(350);nodes=await this.ui();
    }
    // New tasks must not inherit filters selected by an earlier task/person.
    let reset;try{reset=this.locator.locate('sort.reset',nodes);}catch{failed('FILTER_RESET_UNAVAILABLE');}
    await this.tap(reset.node);await this.adb.wait(350);nodes=await this.ui();
    if(!nodes.some(n=>SORT_ANCHORS.includes(label(n)))){
      const opener=this.locator.locate('sort.open',nodes);await this.tap(opener.node);await this.adb.wait(350);nodes=await this.ui();
    }
    let candidate;try{candidate=this.locator.locate('sort.'+value,nodes);}catch{failed('SORT_OPTION_UNAVAILABLE');}
    await this.tap(candidate.node);this.pendingSort={value,candidate};
    await this.adb.wait(350);
    // Selection is not proof that the response honors sorting; capture matching
    // validates the actual request's sort as well.
  }
  confirmSortResponse(actualSort){
    const canonical=actualSort===''?'general':actualSort;
    if(!this.pendingSort || this.pendingSort.value!==canonical)failed('SORT_RESPONSE_MISMATCH');
    const result=this.locator.confirm(this.pendingSort.candidate,'response_sort_verified');this.pendingSort=null;return result;
  }
  hasProfileNotesTab(nodes){
    return nodes.some(n=>/^(?:已选定\s*)?笔记$|^(?:Selected )?Notes$|^노트$/i.test(label(n)));
  }
  discoveryCard(target,nodes){
    const matches=nodes.filter(n=>n.center&&discoveryTitle(n)===target.title);
    const unique=[...new Map(matches.map(n=>[n.center.join(','),n])).values()];
    if(unique.length>1)failed('DISCOVERY_CARD_LOCATOR_AMBIGUOUS');
    return unique[0];
  }
  async positionDiscoveryCard(state,control={}){
    const target=state.card;
    if(!target||!target.title)failed('DISCOVERY_CARD_LOCATOR_UNAVAILABLE');
    const direction=target.index<state.index?-1:1;let waitingForGrid=0;state.trace=[];
    for(let attempt=0;attempt<60;attempt++){
      control.guard?.();const nodes=await this.ui();control.guard?.();
      const profileTab=this.hasProfileNotesTab(nodes);
      if(!profileTab){state.trace.push({action:'wait_for_profile_grid',profile_tab:false});if(waitingForGrid++<12){await this.adb.wait(250);attempt--;continue;}failed('DISCOVERY_GRID_POSITION_UNOBSERVED');}
      const card=this.discoveryCard(target,nodes);
      if(card)return card;
      // Position the current grid before observing the selected note. Scroll
      // prefetch must never satisfy the detail observer for the actual tap.
      const visible=state.cards.filter(c=>c.title&&nodes.some(n=>discoveryTitle(n)===c.title));
      if(!visible.length){state.trace.push({action:'wait_for_profile_grid',profile_tab:true,known_indices:[]});if(waitingForGrid++<12){await this.adb.wait(250);attempt--;continue;}failed('DISCOVERY_GRID_POSITION_UNOBSERVED');}waitingForGrid=0;
      const low=Math.min(...visible.map(c=>c.index)),high=Math.max(...visible.map(c=>c.index));
      if(target.index>=low&&target.index<=high)failed('DISCOVERY_CARD_LOCATOR_UNAVAILABLE');
      const move=target.index<low?-1:target.index>high?1:direction;state.trace.push({action:'swipe',direction:move,known_indices:visible.map(c=>c.index)});await this.swipe(move,control);
    }
    failed('DISCOVERY_CARD_NOT_FOUND');
  }
  async openDiscoveryCard(state,control={},positioned=false){
    let node;
    if(positioned){
      const nodes=await this.ui();
      if(!this.hasProfileNotesTab(nodes))failed('DISCOVERY_GRID_POSITION_UNOBSERVED');
      node=this.discoveryCard(state.card,nodes);
      if(!node)failed('DISCOVERY_CARD_LOCATOR_UNAVAILABLE');
    }else node=await this.positionDiscoveryCard(state,control);
    state.trace.push({action:'tap',index:state.card.index,profile_tab:true,title_match:'exact_observed_title'});
    await this.action(()=>{control.guard?.();return this.adb.tap(node);});state.index=state.card.index;
  }
  async atDiscoveryProfile(state){
    const nodes=await this.ui();
    return this.hasProfileNotesTab(nodes)&&nodes.some(n=>state.cards.some(c=>c.title&&discoveryTitle(n)===c.title));
  }
  async assertDiscoveryProfile(state){
    for(let attempt=0;attempt<3;attempt++){
      if(await this.atDiscoveryProfile(state)){
        state.trace?.push({action:'profile_restored',profile_tab:true,known_card:true});
        return;
      }
      if(attempt<2)await this.adb.wait(350);
    }
    failed('PROFILE_RESTORE_UNCONFIRMED');
  }
  async isNoteScreen(){
    const nodes=await this.ui();
    return nodes.some(n=>n['resource-id']==='com.xingin.xhs:id/moreOperateIV');
  }
  async openNote(noteId){
    if(!/^[a-f0-9]{24}$/.test(noteId))failed('INVALID_NOTE_ID');
    await this.shell('am','start','-a','android.intent.action.VIEW','-d',`xhsdiscover://item/${noteId}`,'-p','com.xingin.xhs');
    await this.adb.wait(350);await this.ui();
  }
  async openProfile(userId){
    if(!/^[a-f0-9]{24}$/.test(userId))failed('INVALID_USER_ID');
    await this.shell('am','start','-a','android.intent.action.VIEW','-d',`xhsdiscover://user/${userId}`,'-p','com.xingin.xhs');
    await this.adb.wait(350);await this.ui();
  }
  async assertProfile(){
    // Read only: a recovery eligibility check must never dismiss an overlay.
    await this.guard();
    if(!isProfileUi(await this.adb.ui()))failed('PROFILE_RESTORE_UNCONFIRMED');
  }

  async restoreProfile(userId){
    await this.openProfile(userId);
    for(let attempt=0;attempt<3;attempt++){
      // UI establishes the page type; the capture validates the requested UID.
      if(isProfileUi(await this.ui()))return;
      if(attempt<2)await this.adb.wait(350);
    }
    failed('PROFILE_RESTORE_UNCONFIRMED');
  }
  async openPlace(observedUrl){
    let url;try{url=new URL(observedUrl);}catch{failed('PLACE_OBSERVED_URL_REQUIRED');}
    if(url.protocol!=='https:'||!['www.xiaohongshu.com','xiaohongshu.com'].includes(url.hostname)||url.username||url.password)failed('PLACE_OBSERVED_URL_REQUIRED');
    await this.shell('am','start','-a','android.intent.action.VIEW','-d',url.href,'-p','com.xingin.xhs');
  }
  async comments(){
    const nodes=await this.ui();
    const controls=nodes.filter(n=>n.center&&/^(?:共\s*)?\d+\s*条评论$|^评论(?:\s*\d+)?$|^Comments?(?:\s*\d+)?$/i.test(label(n)));
    if(controls.length===1){await this.tap(controls[0]);await this.adb.wait(350);return true;}
    await this.swipe();return false;
  }
  async back(){await this.shell('input','keyevent','4');await this.adb.wait(350);}
  async waitForProfileFirstPage(responseReady=()=>false,control={}){
    // Opening the profile triggers its initial request. Keep the grid in place
    // until that response is observed so pagination begins at the first cursor.
    for(let attempt=0;attempt<8;attempt++){
      control.guard?.();
      if(responseReady())return;
      await this.adb.wait(500);
    }
    control.guard?.();
    if(!responseReady())failed('PHONE_FIRST_PAGE_UNOBSERVED');
  }
  async nextPage(responseReady=()=>false,{maxSwipes=12,guard=()=>{}}={}){
    if(!Number.isInteger(maxSwipes)||maxSwipes<1||maxSwipes>120)failed('INVALID_PAGE_SWIPE_LIMIT');
    // Two swipes that leave the screen unchanged mean scrolling is not reaching
    // the list (overlay, end of grid). Stop instead of swiping blind.
    let last=null,unchanged=0;
    for(let attempt=0;attempt<maxSwipes;attempt++){
      guard();if(responseReady())return;
      const before=(await this.swipe(1,{guard}))?.nodes;
      if(!before)continue;
      if(last!==null&&fingerprint(before)===last){if(++unchanged>=2)this.blocked(before);}else unchanged=0;
      last=fingerprint(before);
    }
    if(!responseReady())failed('PHONE_PAGE_RESPONSE_UNOBSERVED');
  }
  // A thumb scroll: varied column, length, slight drift and speed, then a
  // variable look at the result (occasionally a longer read or a small
  // correction back). Returns the screen observed before the swipe.
  async swipe(direction=1,control={}){
    const nodes=await this.ui();const width=Math.max(...nodes.map(n=>n.center?n.center[0]+n.width/2:0));const height=Math.max(...nodes.map(n=>n.center?n.center[1]+n.height/2:0));
    if(width<200||height<400)failed('VIEWPORT_UNAVAILABLE');
    const r=this.random,x=width*between(r,.35,.65),drift=between(r,-40,40);
    const low=height*between(r,.70,.85),high=height*between(r,.22,.40);
    const [y0,y1]=direction<0?[high,low]:[low,high];
    await this.action(()=>{control.guard?.();return this.adb.shell('input','swipe',Math.round(x),Math.round(y0),Math.round(x+drift),Math.round(y1),String(Math.round(between(r,280,650))));});
    if(direction>0&&r()<.07){
      // Small correction back, as when a thumb overshoots.
      const back=height*between(r,.08,.16),y=height*between(r,.35,.55);
      await this.adb.wait(Math.round(between(r,300,700)));
      await this.action(()=>{control.guard?.();return this.adb.shell('input','swipe',Math.round(x),Math.round(y),Math.round(x+between(r,-20,20)),Math.round(y+back),String(Math.round(between(r,250,420))));});
    }
    await this.adb.wait(Math.round(r()<.08?between(r,4000,8000):between(r,900,3500)));
    return {nodes};
  }
}
module.exports={XhsNavigation,SORT_LABELS,label,choose,discoveryTitle};
