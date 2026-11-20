'use strict';
const {problem}=require('../../service/contract');
const {makeTransport}=require('./consumer');
const {XhsNavigation,label}=require('./navigation');

const XHS='com.xingin.xhs';
const denied=/访问已被限制|检测到异常访问|安全验证|验证码|请先登录|账号已退出登录/;
const feedTabs=/^(?:已选定\s*)?(首页|Home|홈)$/i;
const discoverTabs=/^(?:已选定\s*)?(发现|Discover|Explore|발견)$/i;
const cardKind=/^(视频|图文|图片|笔记)(?:[,，]|\s+)/;
const commentEntry=/^(?:共\s*)?\d+\s*条评论$|^查看全部\s*\d*\s*条?评论$|^Comments?$/i;
const commentPanel=/^(全部评论|评论区|共\s*[\d.,万亿]+\s*条评论|All comments|[\d.,]+\s*comments?(?:\(s\))?)$/i;
const liked=/^(?:已点赞|取消点赞|Liked|Unlike)(?:\s|$)/i;
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
const video=nodes=>nodes.some(n=>videoControl.test(label(n))||/:id\/(?:videoPlayerView|videoSeekBar)$/.test(n['resource-id']||''))||
 ['matrixAvatarView','matrixNickNameView','noteContentText'].every(id=>nodes.some(n=>n['resource-id']===XHS+':id/'+id));
function feedCards(nodes){
 const targets=new Map();
 for(const [index,node] of nodes.entries()){
  const kind=label(node).match(cardKind)?.[1];
  if(!node.center||!kind)continue;
  // The home feed exposes a labelled FrameLayout with a separate clickable
  // child. The latter must be the full card, with its centre inside the label.
  const target=node.clickable==='true'?node:nodes[index+1];
  if(!target?.center||target.clickable!=='true')continue;
  if(target!==node&&(!/FrameLayout$/.test(target.class||'')||!/来自|作者/.test(label(node))||!label(node).includes('赞')||
    target.width<node.width*.8||target.height<node.height*.65||
    Math.abs(target.center[0]-node.center[0])>node.width*.1||Math.abs(target.center[1]-node.center[1])>node.height*.25))continue;
  targets.set(target.center.join(','),{target,kind});
 }
 return [...targets.values()];
}

function videoLike(nodes){
 const explicit=unique(nodes.filter(n=>n.center&&n.clickable==='true'&&/^(?:点赞|Like)(?:\s*[\d,.万亿K]+)?$/i.test(label(n))));
 if(explicit)return explicit.selected!=='true'&&explicit.checked!=='true'?explicit:null;
 if(nodes.some(n=>liked.test(label(n))))return null;
 // On the verified video action bar the heart has no description. The two
 // labelled buttons to its right establish its row, width and exact position.
 const buttons=nodes.filter(n=>n.center&&n.clickable==='true'&&/Button$/.test(n.class||''));
 const collect=unique(buttons.filter(n=>/^(?:收藏|Collect)\s*[\d,.万亿K]*$/i.test(label(n))));
 const comment=unique(buttons.filter(n=>/^(?:评论|Comment)\s*[\d,.万亿K]*$/i.test(label(n))));
 if(!collect||!comment||Math.abs(collect.center[1]-comment.center[1])>5)return null;
 const spacing=comment.center[0]-collect.center[0];
 if(spacing<40||Math.abs(spacing-collect.width)>collect.width*.15)return null;
 return unique(nodes.filter(n=>n.center&&n.clickable==='true'&&!label(n)&&n.selected!=='true'&&n.checked!=='true'&&
  /LinearLayout$/.test(n.class||'')&&Math.abs(n.center[1]-collect.center[1])<=5&&Math.abs(n.width-collect.width)<=collect.width*.15&&
  Math.abs(n.center[0]-(collect.center[0]-spacing))<=spacing*.12));
}

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
 const returnToFeed=async nodes=>{
  for(let depth=0;depth<4&&!feed(nodes);depth++){
   const home=unique(nodes.filter(n=>n.center&&feedTabs.test(label(n))));
   if(home)await tap(home);
   else await nav.back();
   nodes=await ui();
  }
  if(!feed(nodes))fail('WARMUP_HOME_UNCONFIRMED');
  return nodes;
 };
 await nav.shell('monkey','-p',XHS,'-c','android.intent.category.LAUNCHER','1');
 await adb.wait(500);
 await returnToFeed(await ui());
 let empty=0;
 for(;;){
  let nodes=await ui();
  if(!feed(nodes))fail('WARMUP_HOME_UNCONFIRMED');
  const cards=feedCards(nodes);
  if(!cards.length){
   if(++empty>3)fail('WARMUP_FEED_CARDS_UNAVAILABLE');
   await swipe(nodes);continue;
  }
  empty=0;
  const card=cards[Math.floor(random()*cards.length)];
  await tap(card.target);
  nodes=await ui();
  if(video(nodes)||card.kind==='视频'){
   const onVideo=()=>!feed(nodes)&&(video(nodes)||detail(nodes));
   while(onVideo()){
    await dwell(duration(3,15));
    nodes=await ui();
    if(!onVideo())break;
    if(random()<.05){
     const like=videoLike(nodes);
     if(like)await tap(like);
    }
    await swipe(nodes);
    nodes=await ui();
   }
   await swipe(await returnToFeed(nodes));
   continue;
  }
  if(feed(nodes)||!detail(nodes))fail('WARMUP_POST_UNCONFIRMED');
  const media=image(nodes);
  if(!media)fail('WARMUP_IMAGE_UNCONFIRMED');
  await swipe(nodes,{across:media});
  const photoMs=duration(3,5);
  await dwell(photoMs);
  if(random()<.10){
   nodes=await ui();
   let entry;
   for(let attempt=0;attempt<3;attempt++){
    if(!detail(nodes)||feed(nodes))fail('WARMUP_POST_UNCONFIRMED');
    await swipe(nodes);
    nodes=await ui();
    entry=unique(nodes.filter(n=>n.center&&n.clickable==='true'&&commentEntry.test(label(n))));
    if(entry){await tap(entry);nodes=await ui();break;}
    if(nodes.some(n=>commentPanel.test(label(n))))break;
   }
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
     if(visibleImage&&!nodes.some(n=>liked.test(label(n)))){
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
  const adb=makeTransport({gateway,store,claim:{device_id:context.device.id,lease:context.lease},context,drainOnStop:true});
  return browseFeed(adb,context);
 };
}
module.exports={warmupBrowser,browseFeed};
