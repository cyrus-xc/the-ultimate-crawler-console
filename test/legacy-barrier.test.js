'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');const {LegacyBarrier}=require('../service/legacy_barrier');
function root(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'legacy-barrier-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('live barrier keeps old global lock while queue leases remain independent',async t=>{
 const dir=root(t),barrier=new LegacyBarrier(dir);await barrier.acquire();assert.equal(fs.readFileSync(path.join(dir,'.worker.lock'),'utf8'),String(barrier.guardianPid));
 await assert.rejects(new LegacyBarrier(dir).acquire(),{code:'LEGACY_WORKER_BUSY'});barrier.assert();await barrier.release();assert.ok(!fs.existsSync(barrier.file));
});
test('startup does not race legacy stale lock reclaim',async t=>{
 const dir=root(t);fs.writeFileSync(path.join(dir,'.worker.lock'),'999999999');const barrier=new LegacyBarrier(dir,{alive:()=>false});
 await assert.rejects(barrier.acquire(),{code:'LEGACY_LOCK_REQUIRES_RECOVERY'});assert.equal(fs.readFileSync(barrier.file,'utf8'),'999999999');
});
test('lost barrier rejects further admission and never removes a replacement owner',async t=>{
 const barrier=new LegacyBarrier(root(t));await barrier.acquire();fs.writeFileSync(barrier.file,'other-owner');assert.throws(()=>barrier.assert(),{code:'LEGACY_BARRIER_LOST'});await barrier.release();assert.equal(fs.readFileSync(barrier.file,'utf8'),'other-owner');
});
