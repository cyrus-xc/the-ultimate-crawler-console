'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {XhsNavigation}=require('../adapters/xhs-phone/navigation');
const node=(text,kind='android.widget.TextView')=>({text,class:kind,center:[20,30]});
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
  let tapped;const nav=new XhsNavigation({ui:async()=>[node(label)],tap:async n=>{tapped=n.text;},wait:async()=>{}},{guard:()=>{}});
  await nav.sort(sort);assert.equal(tapped,label);
 }
});
test('missing sort option is explicit and no alternate sort is selected',async()=>{
 let taps=0;const nav=new XhsNavigation({ui:async()=>[node('综合')],tap:async()=>{taps++;},wait:async()=>{}},{guard:()=>{}});
 await assert.rejects(nav.sort('collect_descending'),{code:'SORT_OPTION_UNAVAILABLE'});assert.equal(taps,1);
});
test('lost device lease prevents input',async()=>{
 let inputs=0;const nav=new XhsNavigation({shell:async()=>{inputs++;}},{guard:()=>{throw Object.assign(new Error('lost'),{code:'LEASE_LOST'});}});
 await assert.rejects(nav.openNote('a'.repeat(24)),{code:'LEASE_LOST'});assert.equal(inputs,0);
});
