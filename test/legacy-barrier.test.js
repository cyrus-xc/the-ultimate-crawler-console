'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');const {LegacyBarrier}=require('../service/legacy_barrier');
function root(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'legacy-barrier-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('live barrier keeps old global lock while queue leases remain independent',async t=>{
 const dir=root(t),barrier=new LegacyBarrier(dir);await barrier.acquire();assert.equal(fs.readFileSync(path.join(dir,'.worker.lock'),'utf8'),String(process.pid));
 await assert.rejects(new LegacyBarrier(dir).acquire(),{code:'LEGACY_WORKER_BUSY'});barrier.assert();await barrier.release();assert.ok(!fs.existsSync(barrier.file));
});
test('startup overwrites the previous PID after acquiring the OS lock',async t=>{
 const dir=root(t);fs.writeFileSync(path.join(dir,'.worker.lock'),'999999999');const barrier=new LegacyBarrier(dir);
 await barrier.acquire();assert.equal(fs.readFileSync(barrier.file,'utf8'),String(process.pid));await barrier.release();
});
test('lost barrier rejects further admission and never removes a replacement owner',async t=>{
 const barrier=new LegacyBarrier(root(t));await barrier.acquire();fs.writeFileSync(barrier.file,'other-owner');assert.throws(()=>barrier.assert(),{code:'LEGACY_BARRIER_LOST'});await barrier.release();assert.equal(fs.readFileSync(barrier.file,'utf8'),'other-owner');
});
