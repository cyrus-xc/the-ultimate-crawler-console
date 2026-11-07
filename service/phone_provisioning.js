'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash,randomUUID}=require('node:crypto');
const {problem}=require('./contract');
const digest=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
class PhoneProvisioner {
 constructor({store,gateway,manifestPath}){this.store=store;this.gateway=gateway;this.manifestPath=manifestPath?path.resolve(manifestPath):null;}
 configured(){if(!this.manifestPath)throw problem('CHROME_PROVISIONING_NOT_CONFIGURED',409);}
 assert(lease){this.configured();this.store.assertLease(lease,{externalOnly:true});return this.gateway.assert(lease);}
 async exportChrome(lease){
  const device=this.assert(lease),result=await this.gateway.execute(lease,{args:['shell','pm','path','com.android.chrome']});
  const apks=result.stdout.trim().split(/\r?\n/).filter(Boolean).map(x=>x.replace(/^package:/,''));
  if(!apks.length||apks.length>40||apks.some(p=>!/^\/data\/app\/[A-Za-z0-9_./=+~-]+\.apk$/.test(p)||path.posix.normalize(p)!==p))throw problem('CHROME_PACKAGE_UNAVAILABLE',409);
  const root=path.dirname(this.manifestPath),folder=path.join(root,'chrome-'+randomUUID());fs.mkdirSync(folder,{recursive:true,mode:0o700});
  const entries=[];
  try{
   for(let i=0;i<apks.length;i++){
    this.assert(lease);const file=path.join(folder,`${i}.apk`);
    await this.gateway.executeTrusted(lease,{args:['pull',apks[i],file]},{timeoutMs:180000});
    fs.chmodSync(file,0o600);entries.push({path:file,sha256:digest(file)});
   }
   const manifest={schema:'chrome.provision.v1',package:'com.android.chrome',source:'adb-package-manager',source_serial:device.serial,created_at:new Date().toISOString(),apks:entries};
   const temp=this.manifestPath+'.'+randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify(manifest,null,2),{mode:0o600,flag:'wx'});fs.renameSync(temp,this.manifestPath);
   return {package:manifest.package,artifacts:entries.length,exported:true};
  }catch(error){fs.rmSync(folder,{recursive:true,force:true});throw error;}
 }
 async installChrome(lease){
  this.assert(lease);let manifest;
  try{manifest=JSON.parse(fs.readFileSync(this.manifestPath,'utf8'));}catch{throw problem('CHROME_ARTIFACT_REQUIRED',409);}
  if(manifest.schema!=='chrome.provision.v1'||manifest.package!=='com.android.chrome'||manifest.source!=='adb-package-manager'||!Array.isArray(manifest.apks)||!manifest.apks.length||manifest.apks.length>40)throw problem('CHROME_MANIFEST_INVALID',409);
  for(const apk of manifest.apks){
   if(typeof apk.path!=='string'||!path.isAbsolute(apk.path)||!/^[a-f0-9]{64}$/.test(apk.sha256||'')||!fs.statSync(apk.path).isFile()||digest(apk.path)!==apk.sha256)throw problem('CHROME_ARTIFACT_DIGEST_MISMATCH',409);
  }
  this.assert(lease);
  await this.gateway.executeTrusted(lease,{args:['install-multiple','-r','--user','0',...manifest.apks.map(a=>a.path)]},{timeoutMs:180000});
  const checked=await this.gateway.execute(lease,{args:['shell','pm','path','com.android.chrome']});
  if(!checked.stdout.includes('package:'))throw problem('CHROME_INSTALL_UNCONFIRMED',502);
  return {package:'com.android.chrome',installed:true,artifacts:manifest.apks.length};
 }
}
module.exports={PhoneProvisioner};
