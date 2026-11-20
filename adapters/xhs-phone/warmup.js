'use strict';
const {problem}=require('../../service/contract');
const {makeTransport}=require('./consumer');
const {XhsNavigation,label}=require('./navigation');

const XHS='com.xingin.xhs';
const denied=/访问已被限制|检测到异常访问|安全验证|验证码|请先登录|账号已退出登录/;
const feedTabs=/^(?:已选定\s*)?(首页|Home|홈)$/i;
const discoverTabs=/^(?:已选定\s*)?(发现|Discover|Explore|발견)$/i;
const cardKind=/^(视频|图文|图片|笔记)[,，]/;
const commentEntry=/^(?:共\s*)?\d+\s*条评论$|^查看全部\s*\d*\s*条?评论$|^Comments?$/i;
const commentPanel=/^(全部评论|评论区|共\s*\d+\s*条评论|All comments)$/i;
const videoControl=/^(?:播放|暂停|播放进度|Play|Pause)$/i;
const fail=code=>{throw problem(code,409);};

const own=nodes=>nodes.filter(n=>n.package===XHS);
const feed=nodes=>nodes.some(n=>feedTabs.test(label(n)))&&nodes.some(n=>discoverTabs.test(label(n)));
const detail=nodes=>nodes.some(n=>n['resource-id']===XHS+':id/moreOperateIV');
const unique=nodes=>nodes.length===1?nodes[0]:null;
function viewport(nodes){
 const width=Math.max(0,...nodes.map(n=>n.center?n.center[0]+n.width/2:0));
 const height=Math.max(0,...nodes.map(n=>n.center?n.center[1]+n.height/2:0));
 if(width<200||height<400)fail('WARMUP_VIEWPORT_UNAVAILABLE');
 return {width,height};
}
function image(nodes){
 const {width,height}=viewport(nodes);
 return nodes.filter(n=>n.center&&(/ImageView$/.test(n.class||'')||/^第\s*\d+\s*张图片/.test(label(n)))&&
  n.width>=width*.65&&n.height>=height*.2&&n.center[1]<height*.68).sort((a,b)=>b.width*b.height-a.width*a.height)[0];
}
const video=nodes=>nodes.some(n=>videoControl.test(label(n))||/:id\/(?:videoPlayerView|videoSeekBar)$/.test(n['resource-id']||''));

async function browseFeed(adb,{guard,dwell,random}){
 const nav=new XhsNavigation(adb,{guard});
 const duration=(min,max)=>Math.round((min+random()*(max-min))*1000);
 const ui=async()=>{
  guard();
  const nodes=await adb.ui();
  if(nodes.some(n=>denied.test(label(n))))fail('XHS_ACCESS_RESTRICTED');
  const app=own(nodes);
  if(!app.length)fail('APP_NOT_READY');
  return app;
 };
 const tap=async n=>{guard();await adb.tap(n);await adb.wait(350);};
 const swipe=async(nodes,{across,down=false}={})=>{
  const {width,height}=viewport(nodes);
  const from=across?[across.center[0]+across.width*.28,across.center[1]]:[width*.5,height*(down?.28:.76)];
  const to=across?[across.center[0]-across.width*.28,across.center[1]]:[width*.5,height*(down?.76:.28)];
  guard();
  await adb.shell('input','swipe',...[...from,...to].map(Math.round),'380');
  await adb.wait(400);
 };
 let nodes;
 await nav.shell('monkey','-p',XHS,'-c','android.intent.category.LAUNCHER','1');
 await adb.wait(500);
 for(let depth=0;depth<4;depth++){
  nodes=await ui();
  if(feed(nodes))break;
  const home=unique(nodes.filter(n=>n.center&&feedTabs.test(label(n))));
  if(home)await tap(home);
  else await nav.back();
 }
 let empty=0;
 for(;;){
  nodes=await ui();
  if(!feed(nodes))fail('WARMUP_HOME_UNCONFIRMED');
  const cards=[...new Map(nodes.filter(n=>n.center&&n.clickable==='true'&&cardKind.test(label(n)))
   .map(n=>[n.center.join(','),n])).values()];
  if(!cards.length){
   if(++empty>3)fail('WARMUP_FEED_CARDS_UNAVAILABLE');
   await swipe(nodes);continue;
  }
  empty=0;
  const card=cards[Math.floor(random()*cards.length)];
  await tap(card);
  nodes=await ui();
  if(feed(nodes)||!detail(nodes)&&!video(nodes))fail('WARMUP_POST_UNCONFIRMED');
  if(video(nodes)||/^视频[,，]/.test(label(card))){
   for(;;){
    if(feed(nodes)||!video(nodes)&&!detail(nodes))fail('WARMUP_VIDEO_UNCONFIRMED');
    await dwell(duration(3,15));
    nodes=await ui();
    if(!video(nodes)&&!detail(nodes)||feed(nodes))fail('WARMUP_VIDEO_UNCONFIRMED');
    if(random()<.05){
     const like=unique(nodes.filter(n=>n.center&&n.clickable==='true'&&n.selected!=='true'&&/^(点赞|Like)$/i.test(label(n))));
     if(like)await tap(like);
    }
    await swipe(nodes);
    nodes=await ui();
   }
  }
  const media=image(nodes);
  if(!media)fail('WARMUP_IMAGE_UNCONFIRMED');
  await swipe(nodes,{across:media});
  const photoMs=duration(3,5);
  await dwell(photoMs);
  if(random()<.10){
   nodes=await ui();
   if(!detail(nodes)||feed(nodes))fail('WARMUP_POST_UNCONFIRMED');
   await swipe(nodes);
   nodes=await ui();
   const entry=unique(nodes.filter(n=>n.center&&n.clickable==='true'&&commentEntry.test(label(n))));
   if(entry){await tap(entry);nodes=await ui();}
   if(nodes.some(n=>commentPanel.test(label(n)))){
    const commentsMs=duration(15,20);
    await dwell(commentsMs);
    if(entry){await nav.back();nodes=await ui();}
    if(photoMs+commentsMs>=10000&&random()<.10&&detail(nodes)&&!feed(nodes)){
     let visibleImage=image(nodes);
     for(let attempt=0;!visibleImage&&attempt<2;attempt++){
      await swipe(nodes,{down:true});
      nodes=await ui();
      if(!detail(nodes)||feed(nodes))fail('WARMUP_POST_UNCONFIRMED');
      visibleImage=image(nodes);
     }
     const unliked=nodes.some(n=>n.selected!=='true'&&/^(点赞|Like)$/i.test(label(n)));
     if(visibleImage&&unliked){
      guard();await adb.tap(visibleImage);
      guard();await adb.tap(visibleImage);
     }
    }
   }
  }
  nodes=await ui();
  if(!feed(nodes)){await nav.back();nodes=await ui();}
  if(!feed(nodes))fail('WARMUP_HOME_UNCONFIRMED');
  await swipe(nodes);
 }
}
function warmupBrowser(store,gateway){
 return context=>{
  const adb=makeTransport({gateway,store,claim:{device_id:context.device.id,lease:context.lease},context});
  return browseFeed(adb,context);
 };
}
module.exports={warmupBrowser,browseFeed};
