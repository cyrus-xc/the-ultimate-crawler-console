'use strict';
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const execute=promisify(execFile);
const {problem}=require('./contract');

// A local supervisor, not an HTTP command: only read explicitly selected phones.
async function verifyPhoneIdle(serial,{adbPath='adb',run=execute}={}){
 const options={timeout:5000,maxBuffer:1024*1024,windowsHide:true};
 const read=async args=>String((await run(adbPath,['-s',serial,...args],options)).stdout);
 if((await read(['get-state'])).trim()!=='device')throw problem('PHONE_NOT_ONLINE',409);
 const processes=await read(['shell','su','-c',"'ps -A -o NAME,ARGS'"]);
 if(!/^\s*NAME[ \t]+ARGS[ \t]*\r?\n[ \t]*\S+[ \t]+\S+/m.test(processes))throw problem('PHONE_PROCESS_LIST_UNAVAILABLE',409);
 if(/xhs-lab-frida|frida-server|uiautomator|com\.android\.commands\.input|(?:^|\s)(?:\/system\/bin\/)?input(?:\s|$)/m.test(processes))throw problem('PHONE_INPUT_ACTIVE',409);
 const forwards=await read(['forward','--list']);
 if(forwards.split(/\r?\n/).some(line=>line.trim().split(/\s+/)[0]===serial))throw problem('PHONE_FORWARD_ACTIVE',409);
}
// Boolean form for callers that only need the proof, never the reason.
async function phoneStopped(serial,options){try{await verifyPhoneIdle(serial,options);return true;}catch{return false;}}
module.exports={verifyPhoneIdle,phoneStopped};
