'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const {RawEvidenceStore}=require('../service/raw_evidence');
const observation={platform:'xiaohongshu',kind:'fixture',subject:{},observed_at:null,source:{provider:'offline_fixture'},outcome:'success'};
test('Node first archive initialization tolerates a Python process holding the original rollback-journal reader',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'raw-init-lock-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const store=new RawEvidenceStore(root),python=process.env.PYTHON||path.resolve(__dirname,'../.venv/bin/python');
 const code="import os,sqlite3,sys,time\nf=sys.argv[1];fd=os.open(f,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);os.close(fd)\nc=sqlite3.connect(f);c.execute('PRAGMA user_version=0');c.execute('BEGIN');c.execute('SELECT * FROM sqlite_master').fetchall();print('reader-ready',flush=True);time.sleep(.25);c.rollback();c.close()";
 const child=spawn(python,['-B','-c',code,store.filename],{env:{...process.env,ENABLE_TIKHUB_NETWORK:'0',ENABLE_LLM_NETWORK:'0'},stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',part=>stderr+=part);const ended=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',status=>status===0?resolve():reject(Error('Fixture child failed: '+stderr)));});
 t.after(()=>{if(child.exitCode===null)child.kill();});
 await new Promise((resolve,reject)=>{child.stdout.once('data',data=>String(data).includes('reader-ready')?resolve():reject(Error('Missing reader handshake')));child.once('error',reject);child.once('close',status=>status!==0&&reject(Error(stderr)));});
 const ref=store.capture(Buffer.from('{"value":0}'),observation);await ended;
 assert.deepEqual(store.readJson(ref),{value:0});assert.deepEqual(store.stats(),{objects:1,observations:1,bytes:11});
});
