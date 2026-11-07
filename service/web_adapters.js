'use strict';
const fs=require('node:fs'),path=require('node:path');
const {XhsWebAdapter}=require('../adapters/xhs-web/adapter');const {DouyinWebAdapter}=require('../adapters/douyin-web/adapter');
function registerWebAdapters(store,{env=process.env}={}){
 const adapters=new Map();const enabled=x=>x==='true'||x==='1';
 if(enabled(env.CRAWLER_XHS_WEB_ENABLED)&&enabled(env.CRAWLER_DOUYIN_WEB_ENABLED)&&env.XHS_BROWSER_PROFILE&&env.DOUYIN_BROWSER_PROFILE&&path.resolve(env.XHS_BROWSER_PROFILE)===path.resolve(env.DOUYIN_BROWSER_PROFILE))throw Object.assign(Error('WEB_PROFILE_CONFLICT'),{code:'WEB_PROFILE_CONFLICT'});
 const specs=[['xiaohongshu','CRAWLER_XHS_WEB_ENABLED',XhsWebAdapter,['link.resolve','search.posts','profile.get','profile.posts','post.detail','post.comments','place.posts']],['douyin','CRAWLER_DOUYIN_WEB_ENABLED',DouyinWebAdapter,['link.resolve','search.posts','profile.get','profile.posts','post.detail','post.comments']]];
 for(const [platform,flag,Adapter,operations] of specs){if(!enabled(env[flag]))continue;
  const id=platform==='xiaohongshu'?'web:xhs:default':'web:douyin:default';const capabilities=operations.map(operation=>({platform,operation,...(operation==='search.posts'?{sorts:platform==='xiaohongshu'?['综合','最新','最多点赞','最多评论','最多收藏']:['综合','最新','最多点赞']}: {})}));
  store.register({id,kind:'web',capabilities});adapters.set(id,new Adapter({env}));
 }
 return adapters;
}
module.exports={registerWebAdapters};
