const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {importLoginQr,removeLoginQr,DESTINATION}=require('../service/login_qr');
test('login QR imports only a bounded PNG to an isolated generated path and removes the private host copy',async()=>{
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64'),calls=[];let local,destination;
 const gateway={executeTrusted:async(lease,{args})=>{assert.equal(lease.token,'owned');calls.push(args);if(args[0]==='push'){local=args[1];assert.deepEqual(fs.readFileSync(local),png);destination=args[2];assert.match(destination,/^\/sdcard\/Pictures\/ultimate-crawler-login-[a-f0-9-]+\.png$/);}}};
 await importLoginQr(gateway,{token:'owned'},png.toString('base64'));assert.equal(fs.existsSync(local),false);assert.equal(calls[1].at(-1),'file://'+destination);await removeLoginQr(gateway,{token:'owned'});assert.deepEqual(calls[2],['shell','rm','-f',destination]);
 await assert.rejects(importLoginQr(gateway,{},Buffer.from('not png').toString('base64')),{code:'INVALID_LOGIN_QR'});assert.equal(calls.length,4);
});

test('repeated QR imports use new names and leases clean up only their own image',async()=>{
 const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',calls=[];
 const gateway={executeTrusted:async(lease,{args})=>calls.push({token:lease.token,args})};
 await importLoginQr(gateway,{token:'first'},png);await importLoginQr(gateway,{token:'second'},png);await importLoginQr(gateway,{token:'first'},png);
 const pushes=calls.filter(c=>c.args[0]==='push');assert.equal(new Set(pushes.map(c=>c.args[2])).size,3);
 await removeLoginQr(gateway,{token:'second'});await removeLoginQr(gateway,{token:'first'});
 for(const call of calls.filter(c=>c.args[1]==='rm'))assert.ok(pushes.some(p=>p.token===call.token&&p.args[2]===call.args.at(-1)));
 assert.equal(calls.filter(c=>c.args[1]==='rm').length,3);
});
