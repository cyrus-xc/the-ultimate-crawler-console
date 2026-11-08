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

test('profile restore uses the exact target deep link and checks profile UI before swiping',async()=>{
 const commands=[],views=[[node('首页')],[node('笔记'),node('粉丝')]];
 const nav=new XhsNavigation({shell:async(...a)=>commands.push(a),ui:async()=>views.shift(),wait:async()=>{}},{guard:()=>{}});
 await nav.restoreProfile('a'.repeat(24));assert.equal(commands[0][5],'xhsdiscover://user/'+ 'a'.repeat(24));
 const wrong=new XhsNavigation({shell:async()=>{},ui:async()=>[node('首页'),node('发现')],wait:async()=>{}},{guard:()=>{}});
 await assert.rejects(wrong.restoreProfile('a'.repeat(24)),{code:'PROFILE_RESTORE_UNCONFIRMED'});
});
test('restored profile replay has an explicit swipe bound and stops before touching on ready',async()=>{
 const nav=new XhsNavigation({}, {guard:()=>{}});let swipes=0;nav.swipe=async()=>{swipes++;};
 await nav.nextPage(()=>true,{maxSwipes:24});assert.equal(swipes,0);
 await assert.rejects(nav.nextPage(()=>false,{maxSwipes:24}),{code:'PHONE_PAGE_RESPONSE_UNOBSERVED'});assert.equal(swipes,24);
 await assert.rejects(nav.nextPage(()=>false,{maxSwipes:121}),{code:'INVALID_PAGE_SWIPE_LIMIT'});
});
const oplusWarning=()=>[
 {...node('“小红书”异常'),'package':'com.oplus.battery'},
 {...node('“小红书”运行异常，建议前往软件商店更新至最新版本。'),'package':'com.oplus.battery'},
 {...node('取消','android.widget.Button'),'package':'com.oplus.battery',clickable:'true',enabled:'true'},
 {...node('更新','android.widget.Button'),'package':'com.oplus.battery',clickable:'true',enabled:'true'},
];
test('known OnePlus XHS abnormal warning is cancelled and UI is read again',async()=>{
 const views=[oplusWarning(),[node('笔记'),node('粉丝')]],taps=[];
 const nav=new XhsNavigation({ui:async()=>views.shift(),tap:async n=>taps.push(n),wait:async()=>{}},{guard:()=>{}});
 assert.deepEqual((await nav.ui()).map(n=>n.text),['笔记','粉丝']);assert.equal(taps.length,1);assert.equal(taps[0].text,'取消');
});
test('OnePlus warning handler never accepts other packages, apps, or generic update dialogs',async()=>{
 for(const mutate of [ns=>ns.map(n=>({...n,package:'other.package'})),ns=>ns.map(n=>({...n,text:n.text.replaceAll('小红书','其他应用')})),ns=>ns.filter(n=>!n.text.includes('运行异常'))]){
  const nodes=mutate(oplusWarning()),taps=[];
  const nav=new XhsNavigation({ui:async()=>nodes,tap:async n=>taps.push(n),wait:async()=>{}},{guard:()=>{}});
  assert.equal(await nav.ui(),nodes);assert.equal(taps.length,0);
 }
});
test('known warning with no unique enabled cancel stops without tapping update',async()=>{
 for(const nodes of [oplusWarning().filter(n=>n.text!=='取消'),[...oplusWarning(),oplusWarning()[2]],oplusWarning().map(n=>n.text==='取消'?{...n,enabled:'false'}:n)]){
  let taps=0;const nav=new XhsNavigation({ui:async()=>nodes,tap:async()=>{taps++;},wait:async()=>{}},{guard:()=>{}});
  await assert.rejects(nav.ui(),{code:'APP_WARNING_CANCEL_UNAVAILABLE'});assert.equal(taps,0);
 }
});
test('persistent OnePlus warning is not clicked repeatedly',async()=>{
 let taps=0;const nav=new XhsNavigation({ui:async()=>oplusWarning(),tap:async()=>{taps++;},wait:async()=>{}},{guard:()=>{}});
 await assert.rejects(nav.ui(),{code:'APP_WARNING_DISMISS_FAILED'});assert.equal(taps,1);
});

test('read-only profile assertion never dismisses an overlay or navigates',async()=>{
 let inputs=0;const adb={ui:async()=>[node('笔记'),node('粉丝')],tap:async()=>{inputs++;},shell:async()=>{inputs++;}};
 const nav=new XhsNavigation(adb,{guard:()=>{}});await nav.assertProfile();assert.equal(inputs,0);
 adb.ui=async()=>oplusWarning();await assert.rejects(nav.assertProfile(),{code:'PROFILE_RESTORE_UNCONFIRMED'});assert.equal(inputs,0);
});
test('discovery relocates backwards one screen and taps only the unique observed card title',async()=>{
 const target={title:'older target',index:2},current={title:'current',index:10},commands=[];let view=0;
 const adb={ui:async()=>[{...node('已选定笔记'),width:0,height:0},{...node(view?'older target':'current'),center:[300,500],width:600,height:1000}],shell:async(...args)=>{commands.push(args);view=1;},tap:async n=>commands.push(['tap',n.text]),wait:async()=>{}};
 const nav=new XhsNavigation(adb,{guard:()=>{}}),state={card:target,cards:[target,current],index:10};await nav.openDiscoveryCard(state);
 assert.equal(commands[0][0],'input');assert.equal(commands[0][1],'swipe');assert.ok(commands[0][3]<commands[0][5]);assert.deepEqual(commands.at(-1),['tap','older target']);assert.equal(state.index,2);
});
test('discovery refuses ambiguous card titles without deep-link or blind swipe',async()=>{
 let inputs=0;const nav=new XhsNavigation({ui:async()=>[node('已选定笔记'),{...node('same'),center:[10,20]},{...node('same'),center:[30,40]}],shell:async()=>inputs++,tap:async()=>inputs++},{guard:()=>{}});
 await assert.rejects(nav.openDiscoveryCard({card:{title:'same',index:1},cards:[],index:3}),{code:'DISCOVERY_CARD_LOCATOR_AMBIGUOUS'});assert.equal(inputs,0);
});
test('observed combined accessibility card description identifies full title without substring guessing',async()=>{
 const {discoveryTitle}=require('../adapters/xhs-phone/navigation');const title='完整标题,内含逗号';
 const card={'content-desc':'视频,'+title+',来自测试作者,18840赞，',center:[300,500],class:'android.widget.FrameLayout',clickable:'true'};
 assert.equal(discoveryTitle(card),title);assert.notEqual(discoveryTitle({'content-desc':'不相关说明'+title}),title);
 let tapped;const nav=new XhsNavigation({ui:async()=>[node('已选定笔记'),card],tap:async n=>{tapped=n;},wait:async()=>{}},{guard:()=>{}});
 await nav.openDiscoveryCard({card:{title,index:2},cards:[{title,index:2}],index:20});assert.equal(tapped,card);
});
test('scrolled discovery profile restore is proven by profile tab and known grid without requiring offscreen header',async()=>{
 const nav=new XhsNavigation({ui:async()=>[node('已选定笔记'),{'content-desc':'视频,known title,来自测试作者,10赞，'}]},{guard:()=>{}});
 await nav.assertDiscoveryProfile({cards:[{title:'known title'}]});
 await assert.rejects(nav.assertDiscoveryProfile({cards:[{title:'different'}]}),{code:'PROFILE_RESTORE_UNCONFIRMED'});
});
test('profile pagination obeys capture-local cancellation before another gesture',async()=>{
 let inputs=0;const nav=new XhsNavigation({ui:async()=>[],shell:async()=>inputs++},{guard:()=>{}});const guard=()=>{throw Object.assign(Error('capture stopped'),{code:'CAPTURE_TIMEOUT'});};
 await assert.rejects(nav.firstPage(()=>false,{guard}),{code:'CAPTURE_TIMEOUT'});await assert.rejects(nav.nextPage(()=>false,{guard}),{code:'CAPTURE_TIMEOUT'});assert.equal(inputs,0);
});
test('discovery waits for observed grid readiness without an input while cards render',async()=>{
 let reads=0,taps=0,swipes=0;const card={'content-desc':'视频,title,来自测试作者,1赞，',center:[200,500]};
 const nav=new XhsNavigation({ui:async()=>++reads<3?[node('已选定笔记')]:[node('已选定笔记'),card],wait:async()=>{},tap:async()=>taps++,shell:async()=>swipes++},{guard:()=>{}});
 const state={card:{title:'title',index:2},cards:[{title:'title',index:2}],index:20};await nav.openDiscoveryCard(state);assert.equal(reads,3);assert.equal(taps,1);assert.equal(swipes,0);assert.equal(state.trace.filter(x=>x.action==='wait_for_profile_grid').length,2);
});
