'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {scanEntry,galleryEntry,loginConfirmation,ensureNoChallenge}=require('../tools/phone_web_login');
const node=text=>({text,center:[10,10],width:20,height:20});
test('login script distinguishes scanner/gallery and requires webpage/device context before confirmation',()=>{
 assert.equal(scanEntry([node('扫一扫')]).text,'扫一扫');assert.equal(galleryEntry([node('相册')]).text,'相册');
 assert.equal(loginConfirmation([node('登录')]),null);assert.equal(loginConfirmation([node('电脑网页版登录'),node('确认登录')]).text,'确认登录');
});
test('login script stops for verification instead of interpreting it as a normal confirmation',()=>{
 assert.throws(()=>ensureNoChallenge([node('安全验证')]),{code:'VERIFICATION_REQUIRED'});assert.doesNotThrow(()=>ensureNoChallenge([node('确认登录网页版')]));
});
