'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {problem}=require('./contract');
const {randomUUID}=require('node:crypto');
const DESTINATION='/sdcard/Pictures/ultimate-crawler-login-';
const uploads=new Map();
async function importLoginQr(gateway,lease,encoded){
 if(typeof encoded!=='string'||encoded.length>3*1024*1024||!/^[A-Za-z0-9+/=]+$/.test(encoded))throw problem('INVALID_LOGIN_QR');
 const bytes=Buffer.from(encoded,'base64');if(bytes.length>2*1024*1024||bytes.length<24||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw problem('INVALID_LOGIN_QR');
 const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);if(!width||!height||width>4096||height>4096)throw problem('INVALID_LOGIN_QR');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'crawler-login-'));fs.chmodSync(dir,0o700);const file=path.join(dir,'qr.png');
 const destination=DESTINATION+randomUUID()+'.png';
 try{await removeLoginQr(gateway,lease);uploads.set(lease.token,destination);fs.writeFileSync(file,bytes,{mode:0o600});await gateway.executeTrusted(lease,{args:['push',file,destination]});await gateway.executeTrusted(lease,{args:['shell','am','broadcast','-a','android.intent.action.MEDIA_SCANNER_SCAN_FILE','-d','file://'+destination]});return {imported:true};}
 catch(error){try{await removeLoginQr(gateway,lease);}catch{}throw error;}
 finally{fs.rmSync(dir,{recursive:true,force:true});}
}
async function removeLoginQr(gateway,lease){const destination=uploads.get(lease.token);if(destination){await gateway.executeTrusted(lease,{args:['shell','rm','-f',destination]});await gateway.executeTrusted(lease,{args:['shell','am','broadcast','-a','android.intent.action.MEDIA_SCANNER_SCAN_FILE','-d','file://'+destination]});uploads.delete(lease.token);}return {removed:true};}
module.exports={importLoginQr,removeLoginQr,DESTINATION};
