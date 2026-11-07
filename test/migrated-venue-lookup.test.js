const test = require('node:test');
const assert = require('node:assert/strict');
const {lookup,candidates,placeShare} = require('../adapters/android-ui/venue_lookup');
const node = (text, attrs={}) => ({text,class:'android.widget.TextView','resource-id':'',center:[400,580],width:600,height:65,...attrs});
const field = value => node(value,{'resource-id':`com.xingin.xhs:id/${value}`,class:'android.widget.EditText'});
const request = {platform:'xiaohongshu',serial:'selected-phone',venue_name:'Example Cafe',query:'Example Cafe 上海'};
const nid = 'a'.repeat(24);

function fixture({poiName='Example Cafe',poiId='B0OBSERVED',fail=false}={}) {
  let state='home', query='', acquired=0,released=0;
  const adb = {
    devices:async()=>[{serial:request.serial,state:'device'}], wait:async()=>{},
    shell:async(...args)=>{
      if(args[0]==='monkey'&&state==='share')state='place';
      return '';
    },
    ui:async()=>{
      if(fail) throw Object.assign(Error('secret device stderr'),{code:'UI_CHANGED'});
      if(state==='home') return [field('search')];
      if(state==='input') return [node('搜索, '+query,{'resource-id':'com.xingin.xhs:id/mSearchToolBarEt',class:'android.widget.EditText'}),field('mSearchToolBarSearchBtn')];
      if(state==='result') return [node('地点'),node('Example Cafe')];
      if(state==='place') return [node('Example Cafe'),node('打卡',{clickable:'true'}),node('笔记'),
        node('上海市南京路1号',{center:[400,700]}),node('',{center:[1040,1000],width:80,height:80}),
        node('',{clickable:'true',center:[850,160],width:79,height:79}),node('',{clickable:'true',center:[1000,160],width:79,height:79}),
        node('来自笔记：a real source',{clickable:'true'})];
      return [];
    },
    tap:async n=>{
      if(n['resource-id']==='com.xingin.xhs:id/search') state='input';
      else if(n['resource-id']==='com.xingin.xhs:id/mSearchToolBarSearchBtn') state='result';
      else if(n.text==='Example Cafe')state='place';
      else if(n.center[0]===1000&&state==='place')state='share';
      else if(n.text.startsWith('来自笔记'))state='note';
    },
    tapLabel:async()=>true,
    copyShare:async()=>{state='noteShare';return true;},
  };
  return {deps:{navigationFactory:()=>({search:async()=>{if(fail)await adb.ui();state='result';}}),adbFactory:()=>adb,worker:{acquire:()=>{acquired++;},release:()=>{released++;}},
    writeClipboard:async(_a,value)=>{query=value;},
    readClipboard:async()=> state==='noteShare'?`https://www.xiaohongshu.com/explore/${nid}`:'https://xhslink.com/m/observed-place',
    expand:async url=>url.includes('xhslink')?'https://www.xiaohongshu.com/apps/sns-poi/detail/0123456789abcdef':url,
    verify:async(url,id)=>{assert.equal(id,nid);return {status:'verified',poi_id:poiId,poi_name:poiName};}},
    counts:()=>({acquired,released}),adb};
}

test('lookup uses an explicit phone and independently observes the note POI namespace',async()=>{
  const f=fixture();const r=await lookup(request,f.deps);
  assert.equal(r.status,'observed'); assert.equal(r.candidate.poi_id,'B0OBSERVED');
  assert.equal(r.candidate.place_page_id,'0123456789abcdef');assert.equal(r.candidate.source_note_id,nid);
  assert.equal(r.candidate.address,'上海市南京路1号');assert.deepEqual(f.counts(),{acquired:1,released:1});
});
test('a differently named note POI cannot confirm a venue, and hex IDs are never decoded',async()=>{
  const f=fixture({poiName:'Unrelated cafe'}),r=await lookup(request,f.deps);
  assert.equal(r.status,'needs_review');assert.equal(r.candidate.poi_id,null);assert.equal(r.candidate.place_page_id,'0123456789abcdef');
});
test('missing device and unsupported platforms do not acquire a worker or touch a phone',async()=>{
  const f=fixture();f.adb.devices=async()=>[];
  await assert.rejects(lookup(request,f.deps),e=>e.code==='DEVICE_UNAVAILABLE');
  await assert.rejects(lookup({...request,platform:'douyin'},f.deps),e=>e.code==='VENUE_LOOKUP_PLATFORM_UNVERIFIED');
  assert.deepEqual(f.counts(),{acquired:0,released:0});
});
test('a phone failure releases the shared worker',async()=>{
  const f=fixture({fail:true});await assert.rejects(lookup(request,f.deps),e=>e.code==='UI_CHANGED');
  assert.deepEqual(f.counts(),{acquired:1,released:1});
});
test('recommended places after no results are never treated as matches',()=>{
  assert.deepEqual(candidates([node('无相关搜索结果，为你推荐更多地点'),node('Example Cafe')],['Example Cafe']),[]);
  assert.throws(()=>placeShare([node('Example Cafe')]),e=>e.code==='VENUE_SHARE_UI_CHANGED');
});
