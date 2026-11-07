'use strict';
// High-level phone work lives with the device owner. Pipeline sends intent only.
const {AndroidAdb}=require('../adapters/douyin-phone/android_adb');
const links=require('../adapters/android-ui/link_recovery');
const {lookup}=require('../adapters/android-ui/venue_lookup');
const douyin=require('../adapters/douyin-phone/harvest');
const {readAndroidClipboard,writeAndroidClipboard}=require('../adapters/douyin-phone/android_clipboard');
const {problem}=require('./contract');
const ADB_METHODS=new Set(['ui','openNote','copyShare','tap','tapLabel','shell']);
async function phoneUtility({store,gateway,lease,serial,operation,params={},signal,guard}){
 guard();const device=store.devices().find(d=>d.id===lease.device_id);
 if(!device||device.kind!=='android'||device.serial!==serial)throw problem('DEVICE_IDENTITY_MISMATCH',409);
 const worker={queue:true,clipboardPort:device.clipboard_port,client:{devices:async()=>({devices:[{...device,connection_state:'device'}]})},
  acquire:async id=>{guard();if(id!==serial)throw problem('DEVICE_IDENTITY_MISMATCH',409);},release:async()=>{},
  command:async(id,args)=>{guard();if(id!==serial)throw problem('DEVICE_IDENTITY_MISMATCH',409);return gateway.execute(lease,{serial,args},{signal});}};
 const adbFactory=(id,options={})=>new AndroidAdb(id,{...options,worker,env:{CRAWLER_DEVICE_LOCK_MODE:'queue'},signal});
 const adb=adbFactory(serial);let result;
 if(operation==='link.recover')result=await links.recoverLink(params.row,{serial,worker,adbFactory,signal});
 else if(operation==='venue.lookup')result=await lookup({...params,serial},{worker,adbFactory,guard});
 else if(operation==='douyin.inspect')result=await douyin.inspectPost(adb,{videoId:params.videoId});
 else if(operation==='clipboard.read')result=await readAndroidClipboard(adb);
 else if(operation==='clipboard.write'){if(typeof params.text!=='string'||params.text.length>8192)throw problem('INVALID_PARAMS');result=await writeAndroidClipboard(adb,params.text);}
 else if(operation.startsWith('adb.')&&ADB_METHODS.has(operation.slice(4))){if(!Array.isArray(params.args)||params.args.length>32)throw problem('INVALID_PARAMS');result=await adb[operation.slice(4)](...params.args);}
 else throw problem('UNSUPPORTED_PHONE_UTILITY');
 guard();return {result:result??null};
}
async function linkUtility(operation,params,signal){
 if(!links.allowedUrl(params?.url))throw problem('INVALID_LINK');
 if(operation==='expand')return {result:await links.expandLink(params.url,{signal})};
 if(operation==='verify'&&/^[a-f0-9]{24}$/.test(params.note_id||''))return {result:await links.verifyOnPhone(params.url,params.note_id,{signal})};
 throw problem('UNSUPPORTED_LINK_UTILITY');
}
module.exports={phoneUtility,linkUtility};
