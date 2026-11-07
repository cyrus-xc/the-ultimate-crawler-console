const test=require('node:test');const assert=require('node:assert/strict');
const {harvest}=require('../adapters/douyin-phone/harvest');
function fakePhone({captchaAt=-1,stuck=false,copyIgnored=false,width=1080,height=2340}={}) {
 let state='seed',index=0;const calls=[],waits=[];
 const n=(text,desc,bounds,attrs='')=>{
  let i=0;const scaled=bounds.replace(/\d+/g,v=>String(Math.round(Number(v)*(i++%2===0?width/1080:height/2340))));
  return `<node text="${text}" content-desc="${desc}" bounds="${scaled}" ${attrs} />`;
 };
 const detail=()=>[n('ATELIER玖楼','','[100,1450][500,1510]'),n('@同一作者','','[30,1540][600,1600]'),n(`第${index+1}篇不同的门店正文内容`,'','[30,1650][700,1800]'),n('','分享，按钮','[920,1550][1050,1650]')].join('');
 const sharing=()=>n('私信','','[216,2078][392,2122]')+n('分享链接','','[789,2078][965,2122]')+n('','','[789,1912][965,2122]','clickable="true"');
 const xml=()=>`<hierarchy><node bounds="[0,0][${width},${height}]">`+ (index===captchaAt?n('请完成下列验证后继续','','[100,400][900,700]'):state==='list'?n('','第一篇','[45,1700][511,1790]')+n('','同一作者','[101,1810][250,1860]'):state==='share'?sharing():state==='confirmed'?n('链接已复制成功，去粘贴分享：','','[45,1633][945,1695]')+n('','','[945,1619][1035,1709]','class="android.widget.ImageView" clickable="true"'):detail())+'</node></hierarchy>';
 const adb={serial:'fixture',wait:async ms=>waits.push(ms),shell:async(...a)=>{
  calls.push(a);
  if(a[0]==='wm')return `Physical size: ${width}x${height}`;
  if(a[0]==='cat')return xml();
  if(a[0]==='dumpsys')return `topResumedActivity=x com.ss.android.ugc.aweme/${state==='list'?'LifePoiActivity':'DetailActivity'}`;
  if(a[0]==='am'){state='seed';return '';}
  if(a[0]==='monkey'){state='detail';return '';}
  if(a[0]==='input'&&a[1]==='keyevent'){state='closed';return '';}
  if(a[0]==='input'&&a[1]==='swipe'){if(!stuck)index++;state='detail';return '';}
  if(a[0]==='input'&&a[1]==='tap'){
   if(state==='seed')state='list';else if(state==='list')state='detail';else if(state==='detail'&&Number(a[2])>width*0.74)state='share';else if(state==='share'&&!copyIgnored){
    assert.ok(Number(a[2])>width*789/1080&&Number(a[2])<width*965/1080,'only the link action');
    assert.ok(Number(a[3])<height*2078/2340,'tap the real clickable container, not the unclickable caption');state='confirmed';
   }else if(state==='confirmed'){assert.ok(Number(a[2])>width*945/1080,'close the copy confirmation, never a friend');state='detail';}
  }
  return '';
 }};
 return {adb,calls,waits,clipboard:async()=>{state='chrome';return `https://www.douyin.com/video/${(1791302400n<<32n)+BigInt(index+1)}`;}};
}
test('six location posts stream by one vertical swipe each, without returning to the list or dropping the same author',async()=>{
 const f=fakePhone(),events=[];
 const result=await harvest(f.adb,{video:'7686405267591810323',names:['ATELIER玖楼'],max:6,clipboard:f.clipboard,emit:e=>events.push(e)});
 assert.equal(result.posts.length,6);
 assert.equal(new Set(result.posts.map(p=>p.video_id)).size,6);
 assert.equal(f.calls.filter(a=>a[0]==='input'&&a[1]==='swipe').length,5);
 assert.equal(f.calls.filter(a=>a[0]==='input'&&a[1]==='keyevent').length,0);
 assert.ok(f.waits.reduce((a,b)=>a+b,0)<15000,'fixed action waits must not consume 30 seconds per post');
 assert.equal(events.filter(e=>e.event==='post').length,6);
});

for(const [width,height] of [[720,1560],[1080,1920],[1440,3120]]) {
 test(`phone feed uses readable UI bounds at ${width}x${height}`,async()=>{
  const f=fakePhone({width,height});
  const result=await harvest(f.adb,{video:'7686405267591810323',names:['ATELIER玖楼'],max:6,clipboard:f.clipboard});
  assert.equal(result.posts.length,6);
  for(const a of f.calls.filter(a=>a[0]==='input'&&a[1]==='swipe')){
   assert.ok(Number(a[2])>width*0.3&&Number(a[2])<width*0.7);
   assert.ok(Number(a[3])<height&&Number(a[5])<Number(a[3]));
  }
 });
}
test('a check on the next post pauses before any share or further swipe',async()=>{
 const f=fakePhone({captchaAt:1}),events=[];
 await assert.rejects(harvest(f.adb,{video:'7686405267591810323',names:['ATELIER玖楼'],max:6,clipboard:f.clipboard,emit:e=>events.push(e)}),e=>e.code==='PHONE_CAPTCHA');
 assert.equal(events.filter(e=>e.event==='post').length,1);
 assert.equal(f.calls.filter(a=>a[0]==='input'&&a[1]==='swipe').length,1);
});

test('an ignored first copy never assigns the old clipboard to the first post',async()=>{
 const f=fakePhone({copyIgnored:true});let reads=0;
 await assert.rejects(harvest(f.adb,{video:'7686405267591810323',names:['ATELIER玖楼'],max:6,
  clipboard:async()=>{reads++;return 'https://www.douyin.com/video/7670134194719182537';}}),e=>e.code==='COPY_NOT_CONFIRMED');
 assert.equal(reads,0);
 assert.equal(f.calls.filter(a=>a[0]==='input'&&a[1]==='swipe').length,0);
});

test('a stale clipboard on a different post pauses instead of declaring the feed complete',async()=>{
 const f=fakePhone(),events=[];
 await assert.rejects(harvest(f.adb,{video:'7686405267591810323',names:['ATELIER玖楼'],max:6,
  clipboard:async()=> 'https://www.douyin.com/video/7686405267591810323',emit:e=>events.push(e)}),e=>e.code==='STALE_CLIPBOARD');
 assert.equal(events.filter(e=>e.event==='post').length,1);
 assert.equal(events.filter(e=>e.event==='done').length,0);
});

test('a stationary feed pauses after two attempted transitions and never claims all posts were read',async()=>{
 const f=fakePhone({stuck:true}),events=[];
 await assert.rejects(harvest(f.adb,{video:'7686405267591810323',names:['ATELIER玖楼'],max:6,
  clipboard:f.clipboard,emit:e=>events.push(e)}),e=>e.code==='FEED_STALLED');
 assert.equal(events.filter(e=>e.event==='post').length,1);
 assert.equal(events.filter(e=>e.event==='done').length,0);
 assert.equal(f.calls.filter(a=>a[0]==='input'&&a[1]==='swipe').length,2);
});

test('resuming skips saved IDs but keeps different posts from that same author',async()=>{
 const f=fakePhone();
 const id=String((1791302400n<<32n)+1n);
 const result=await harvest(f.adb,{video:'7686405267591810323',names:['ATELIER玖楼'],max:6,
  knownIds:[id],clipboard:f.clipboard});
 assert.equal(result.posts.length,5);
 assert.ok(result.posts.every(p=>p.video_id!==id));
});
