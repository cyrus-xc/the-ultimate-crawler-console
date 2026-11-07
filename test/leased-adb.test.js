'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const {LeasedAdb}=require('../android/leased_adb');
test('lease revocation during transient ADB failure prevents retry and keeps lease error',async()=>{
 let live=true,commands=0;const adb=new LeasedAdb('test-serial',{guard:()=>{if(!live)throw Object.assign(Error('lost'),{code:'LEASE_LOST'});},execute:async()=>{commands++;live=false;throw Object.assign(Error('transient'),{code:'EIO'});}});
 adb.wait=async()=>{};await assert.rejects(adb.shell('input','keyevent','4'),{code:'LEASE_LOST'});assert.equal(commands,1);
});
