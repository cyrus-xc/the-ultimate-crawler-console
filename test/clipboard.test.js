'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {writeAndroidClipboard}=require('../android/android_clipboard');
test('clipboard helper survives regional prompt without accepting terms or signing in',async()=>{
 let endpoint,keptProvider=false,helperClicked=false;const labels=[];
 const adb={serial:'fake',executable:'adb',execute:async()=>({stdout:''}),command:async()=>'',shell:async(...args)=>{const at=args.indexOf('-d');if(at!==-1)endpoint=args[at+1];},wait:async()=>{},tapLabel:async values=>{
  labels.push(...values);
  if(values.includes('继续使用 Google')){keptProvider=true;return true;}
  if(values.includes('写入搜索文字')&&keptProvider){const response=await fetch(endpoint,{method:'POST',body:'written'});assert.equal(response.status,200);helperClicked=true;return true;}
  return false;
 }};
 await writeAndroidClipboard(adb,'咖啡',{port:0});assert.ok(helperClicked);assert.ok(keptProvider);assert.ok(!labels.some(s=>/登录|接受|同意/.test(s)));
});
