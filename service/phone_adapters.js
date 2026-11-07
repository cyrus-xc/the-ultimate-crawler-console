'use strict';
const fs=require('node:fs'),path=require('node:path');
const {PhoneConsumer,NATIVE}=require('../adapters/xhs-phone/consumer');
const {SORT_LABELS}=require('../adapters/xhs-phone/navigation');
const fail=code=>Object.assign(Error(code),{code});
// A deployment-owned file lists serials and their actually verified operations.
// Discovery alone does not advertise an unverified collector capability.
function uiCapabilities(device){
 const requested=device.ui_capabilities ?? (device.ui_helpers===true?[{platform:'xiaohongshu',operation:'place.search'},{platform:'xiaohongshu',operation:'post.detail'},{platform:'douyin',operation:'post.detail'}]:[]);
 if(!Array.isArray(requested)||requested.some(c=>!c||!['xiaohongshu','douyin'].includes(c.platform)||!['post.detail','place.search'].includes(c.operation)||(c.operation==='place.search'&&c.platform!=='xiaohongshu')))throw fail('INVALID_PHONE_CAPABILITIES');
 return requested.map(c=>({platform:c.platform,operation:c.operation,...(c.operation==='post.detail'?{representations:['ui_identity']}: {})}));
}
function phoneConfig(env=process.env){
 if(!['1','true'].includes(env.CRAWLER_PHONE_ENABLED))return null;
 if(!env.CRAWLER_PHONE_CONFIG_FILE)throw fail('PHONE_CONFIG_REQUIRED');
 const config=JSON.parse(fs.readFileSync(env.CRAWLER_PHONE_CONFIG_FILE,'utf8'));
 if(!Array.isArray(config.devices)||!config.devices.length)throw fail('INVALID_PHONE_CONFIG');
 if(typeof config.python!=='string'||typeof config.binary!=='string'||!/^[a-f0-9]{64}$/.test(config.sha256||''))throw fail('INVALID_PHONE_RUNTIME_CONFIG');
 for(const d of config.devices){
  uiCapabilities(d);
  if(!/^[\w.:-]+$/.test(d.serial||'')||!Array.isArray(d.operations)||!d.operations.length||d.operations.some(o=>!NATIVE[o]))throw fail('INVALID_PHONE_CAPABILITIES');
  if(d.sorts!==undefined&&(!Array.isArray(d.sorts)||d.sorts.some(s=>!SORT_LABELS[s])))throw fail('INVALID_PHONE_CAPABILITIES');
 }
 return {...config,contractPath:config.contractPath||path.resolve(__dirname,'../contracts/xhs-app-9.51.0.json')};
}
function registerPhoneAdapters({store,gateway,adapters,config,selectorRoot}){
 if(!config)return [];
 if(!gateway)throw fail('PHONE_GATEWAY_REQUIRED');
 const registered=[];
 for(const d of config.devices){
  const existing=store.devices().find(x=>x.kind==='android'&&x.serial===d.serial);if(!existing||existing.owner||adapters.has(existing.id))continue;
  const capabilities=d.operations.map(operation=>({platform:'xiaohongshu',operation,...(operation==='search.posts'?{sorts:(d.sorts||['general']).flatMap(s=>[s,SORT_LABELS[s]])}: {})}));
  store.register({id:existing.id,kind:'android',serial:d.serial,capabilities});
  const consumer=new PhoneConsumer({store,gateway,deviceId:existing.id,python:config.python,contractPath:config.contractPath,binary:config.binary,sha256:config.sha256,selectorRoot,verifiedOperations:d.operations});
  adapters.set(existing.id,consumer);registered.push(existing.id);
 }
 return registered;
}
module.exports={phoneConfig,registerPhoneAdapters,uiCapabilities};
