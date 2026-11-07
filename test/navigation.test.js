'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {XhsNavigation}=require('../adapters/xhs-phone/navigation');
const node=(text,kind='android.widget.TextView')=>({text,class:kind,center:[20,30]});
const quickGeneral=()=>({...node('综合'),center:[20,5],selected:'true'});
test('obfuscated resource IDs do not prevent label-driven search input',async()=>{
 const views=[[node('搜索')],[node('','android.widget.EditText')],[node('旧词','android.widget.EditText')],[node('咖啡','android.widget.EditText')]];const commands=[];let guards=0,clipboard;
 const adb={ui:async()=>views.shift(),shell:async(...a)=>commands.push(a),tap:async n=>commands.push(['tap',n.text]),wait:async()=>{}};
 const nav=new XhsNavigation(adb,{guard:()=>{guards++;},writeClipboard:async(a,value)=>{clipboard=value;}});await nav.search('咖啡');
 assert.equal(clipboard,'咖啡');assert.deepEqual(commands.at(-1),['input','keyevent','66']);assert.ok(guards>5);
});
test('ambiguous search controls stop rather than using a guessed coordinate',async()=>{
 const nav=new XhsNavigation({shell:async()=>{},ui:async()=>[node('搜索'),node('搜索')]},{guard:()=>{}});
 await assert.rejects(nav.search('coffee'),{code:'SEARCH_CONTROL_UNAVAILABLE'});
});
test('all five supported sort labels can be selected without changing semantics',async()=>{
 const {SORT_LABELS}=require('../adapters/xhs-phone/navigation');
 for(const [sort,label] of Object.entries(SORT_LABELS)){
  let tapped;const nav=new XhsNavigation({shell:async()=>{},ui:async()=>[quickGeneral(),node(label),node('重置'),...(label==='最多点赞'?[]:[node('最多点赞')])],tap:async n=>{tapped=n.text;},wait:async()=>{}},{guard:()=>{}});
  await nav.sort(sort);assert.equal(tapped,label);
 }
});
test('missing sort option is explicit and no alternate sort is selected',async()=>{
 let taps=0;const nav=new XhsNavigation({shell:async()=>{},ui:async()=>[quickGeneral(),node('综合'),node('重置'),node('最多点赞')],tap:async()=>{taps++;},wait:async()=>{}},{guard:()=>{}});
 await assert.rejects(nav.sort('collect_descending'),{code:'SORT_OPTION_UNAVAILABLE'});assert.equal(taps,1);
});
test('lost device lease prevents input',async()=>{
 let inputs=0;const nav=new XhsNavigation({shell:async()=>{inputs++;}},{guard:()=>{throw Object.assign(new Error('lost'),{code:'LEASE_LOST'});}});
 await assert.rejects(nav.openNote('a'.repeat(24)),{code:'LEASE_LOST'});assert.equal(inputs,0);
});

test('latest shortcut is bypassed in favor of chronological menu sort',async()=>{
 const shortcut=node('最新');shortcut.center=[20,10];const menu=node('最新');menu.center=[20,80];
 const anchor=node('最多点赞');anchor.center=[80,80];
 const reset=node('重置');reset.center=[50,120];const views=[[node('全部'),shortcut,quickGeneral()],[menu,anchor,reset,quickGeneral()],[menu,anchor,reset,quickGeneral()]];const taps=[];
 const nav=new XhsNavigation({ui:async()=>views.shift(),tap:async n=>taps.push(n),wait:async()=>{}},{guard:()=>{}});
 await nav.sort('time_descending');assert.equal(taps[0].text,'全部');assert.equal(taps[1],reset);assert.equal(taps[2],menu);
});
test('query control is re-resolved if first tap only dismisses a filter sheet',async()=>{
 const control=(text,x)=>({...node(text),center:[x,30],height:20,clickable:'true'});
 const query=control('旧词',50);const tree=[control('返回',10),query,control('全部删除',80),control('搜索',100)];
 const views=[tree,tree,[node('','android.widget.EditText')],[node('','android.widget.EditText')],[node('咖啡','android.widget.EditText')]];
 const taps=[];const nav=new XhsNavigation({ui:async()=>views.shift(),shell:async()=>{},tap:async n=>taps.push(n),wait:async()=>{}},{guard:()=>{},writeClipboard:async()=>{}});
 await nav.search('咖啡');assert.equal(taps[0],query);assert.equal(taps[1],query);
});
test('search returns from a previous detail by normal Back navigation',async()=>{
 const views=[[node('A previous post')],[node('搜索')],[node('','android.widget.EditText')],[node('','android.widget.EditText')],[node('咖啡','android.widget.EditText')]],commands=[];
 const nav=new XhsNavigation({ui:async()=>views.shift(),shell:async(...a)=>commands.push(a),tap:async()=>{},wait:async()=>{}},{guard:()=>{},writeClipboard:async()=>{}});
 await nav.search('咖啡');assert.ok(commands.some(a=>a.join(' ')==='input keyevent 4'));
});
test('page navigation stops at the first observed response instead of blind multi-swipes',async()=>{
 const nav=new XhsNavigation({}, {guard:()=>{}});let swipes=0;nav.swipe=async()=>{swipes++;};await nav.nextPage(()=>swipes===3);assert.equal(swipes,3);
 swipes=0;await assert.rejects(nav.nextPage(()=>false),{code:'PHONE_PAGE_RESPONSE_UNOBSERVED'});assert.equal(swipes,12);
});
