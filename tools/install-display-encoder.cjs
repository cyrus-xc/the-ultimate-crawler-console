'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{createHash,randomUUID}=require('node:crypto');
const {VERSION,SHA256}=require('../service/scrcpy_video');
(async()=>{
 const target=process.env.CRAWLER_SCRCPY_SERVER||path.resolve(__dirname,'../runtime/scrcpy-server-v'+VERSION);
 const response=await fetch(`https://github.com/Genymobile/scrcpy/releases/download/v${VERSION}/scrcpy-server-v${VERSION}`,{signal:AbortSignal.timeout(60000)});
 if(!response.ok)throw Error('ENCODER_DOWNLOAD_FAILED');
 const bytes=Buffer.from(await response.arrayBuffer());if(createHash('sha256').update(bytes).digest('hex')!==SHA256)throw Error('ENCODER_CHECKSUM_FAILED');
 await fs.mkdir(path.dirname(target),{recursive:true});const temporary=target+'.'+randomUUID();
 try{await fs.writeFile(temporary,bytes,{mode:0o600,flag:'wx'});await fs.rename(temporary,target);}finally{await fs.rm(temporary,{force:true});}
 console.log('Installed scrcpy server '+VERSION);
})().catch(error=>{console.error(error.message);process.exitCode=1;});
