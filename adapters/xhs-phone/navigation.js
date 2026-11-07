'use strict';
const {DevicePause}=require('../../android/android_adb');
const {writeAndroidClipboard}=require('../../android/android_clipboard');
const {UiLocator}=require('../../android/ui_locator');
const SORT_LABELS={general:'综合',time_descending:'最新',popularity_descending:'最多点赞',comment_descending:'最多评论',collect_descending:'最多收藏'};
const label=n=>String(n?.text||n?.['content-desc']||'').trim();
const failed=code=>{throw new DevicePause(code,code);};
function choose(nodes,predicate,code){const found=nodes.filter(predicate);if(found.length!==1)failed(code);return found[0];}
class XhsNavigation {
  constructor(adb,{guard,writeClipboard=writeAndroidClipboard,locator,clipboardPort}={}) {
    if(typeof guard!=='function')throw new Error('Device lease guard required');
    this.adb=adb;this.guard=guard;this.writeClipboard=writeClipboard;
    this.clipboardPort=clipboardPort;this.locator=locator||new UiLocator({serial:adb.serial||'offline',appVersion:'unverified'});this.pendingSort=null;
  }
  async action(fn){await this.guard();return await fn();}
  async ui(){await this.guard();return this.adb.ui();}
  async shell(...args){return this.action(()=>this.adb.shell(...args));}
  async tap(node){return this.action(()=>this.adb.tap(node));}
  async search(keyword,{submit=true}={}) {
    if(typeof keyword!=='string'||!keyword.trim()||keyword.length>200)failed('INVALID_KEYWORD');
    await this.shell('monkey','-p','com.xingin.xhs','-c','android.intent.category.LAUNCHER','1');
    let nodes=await this.ui();
    let edits=nodes.filter(n=>/EditText$/.test(n.class||''));
    if(!edits.length){
      let search;try{search=this.locator.locate('search.query',nodes);}catch{}
      if(!search){try{search=this.locator.locate('search.open',nodes);}catch{failed('SEARCH_CONTROL_UNAVAILABLE');}}
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
    nodes=await this.ui();const actual=label(choose(nodes,n=>/EditText$/.test(n.class||'')&&n.center,'SEARCH_INPUT_UNAVAILABLE')).replace(/^搜索,\s*/,'');
    if(actual!==keyword)failed('SEARCH_INPUT_MISMATCH');
    this.locator.confirm(inputCandidate,'search_text_verified');
    if(submit)await this.submitSearch();
  }
  async submitSearch(){await this.shell('input','keyevent','66');await this.adb.wait(500);}
  async sort(value){
    const wanted=SORT_LABELS[value];if(!wanted)failed('UNSUPPORTED_SORT');
    let nodes=await this.ui();
    let quick;try{quick=this.locator.locate('filter.quick_general',nodes);}catch{failed('QUICK_FILTER_RESET_UNAVAILABLE');}
    if(quick.node.selected!=='true'){await this.tap(quick.node);await this.adb.wait(350);nodes=await this.ui();}
    const expanded=nodes.some(n=>['最多点赞','最多评论','最多收藏'].includes(label(n)));
    if(!expanded){
      let opener;try{opener=this.locator.locate('sort.open',nodes);}catch{failed('SORT_CONTROL_UNAVAILABLE');}
      await this.tap(opener.node);await this.adb.wait(350);nodes=await this.ui();
    }
    // New tasks must not inherit filters selected by an earlier task/person.
    let reset;try{reset=this.locator.locate('sort.reset',nodes);}catch{failed('FILTER_RESET_UNAVAILABLE');}
    await this.tap(reset.node);await this.adb.wait(350);nodes=await this.ui();
    if(!nodes.some(n=>['最多点赞','最多评论','最多收藏'].includes(label(n)))){
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
  async openNote(noteId){
    if(!/^[a-f0-9]{24}$/.test(noteId))failed('INVALID_NOTE_ID');
    await this.shell('am','start','-a','android.intent.action.VIEW','-d',`xhsdiscover://item/${noteId}`,'-p','com.xingin.xhs');
  }
  async swipe(){
    const nodes=await this.ui();const width=Math.max(...nodes.map(n=>n.center?n.center[0]+n.width/2:0));const height=Math.max(...nodes.map(n=>n.center?n.center[1]+n.height/2:0));
    if(width<200||height<400)failed('VIEWPORT_UNAVAILABLE');
    await this.shell('input','swipe',Math.round(width*.5),Math.round(height*.78),Math.round(width*.5),Math.round(height*.3),'450');
    await this.adb.wait(500);
  }
}
module.exports={XhsNavigation,SORT_LABELS,label,choose};
