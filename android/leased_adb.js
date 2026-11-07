'use strict';
const {execFile}=require('node:child_process');const {promisify}=require('node:util');
const {AndroidAdb}=require('./android_adb');
class LeasedAdb extends AndroidAdb {
 constructor(serial,{guard,...options}){
  if(typeof guard!=='function')throw new Error('Device lease guard required');
  const execute=options.execute||promisify(execFile);
  super(serial,{...options,execute:async(...args)=>{await guard();return await execute(...args);}});
 }
}
module.exports={LeasedAdb};
