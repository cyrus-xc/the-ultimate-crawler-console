'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const {Store}=require('../service/store'),{DeviceInventory}=require('../service/device_inventory');
test('discovery registers physical devices without claiming collection capabilities',async t=>{
 const s=new Store();t.after(()=>s.close());const inventory=new DeviceInventory(s,{execute:async()=>({stdout:'List of devices attached\ns1 device product:p model:Phone\ns2 unauthorized model:Locked\n'})});
 await inventory.refresh();const devices=s.devices();assert.equal(devices.length,1);assert.equal(devices[0].serial,'s1');assert.deepEqual(devices[0].capabilities,[]);assert.equal(inventory.describe(devices[0]).connection_state,'device');
});
test('reconnect restores connection state but never clears quarantine or platform faults',async t=>{
 const s=new Store();t.after(()=>s.close());s.register({id:'p',serial:'s1',kind:'android',capabilities:[]});let online=false;
 const inventory=new DeviceInventory(s,{execute:async()=>({stdout:'List of devices attached\n'+(online?'s1 device model:Phone\n':'')})});
 await inventory.refresh();assert.equal(s.devices()[0].health,'disconnected');s.db.prepare('UPDATE devices SET quarantined=1,faults=? WHERE id=?').run(JSON.stringify({xiaohongshu:'LOGIN_REQUIRED'}),'p');
 online=true;await inventory.refresh();const device=s.devices()[0];assert.equal(device.quarantined,1);assert.equal(device.faults.xiaohongshu,'LOGIN_REQUIRED');assert.equal(inventory.describe(device).connection_state,'device');
});
test('busy devices are refreshed without registration replacing their lease',async t=>{
 const s=new Store();t.after(()=>s.close());s.register({id:'p',serial:'s1',kind:'android',capabilities:[]});const lease=s.externalLease('p','test');
 const inventory=new DeviceInventory(s,{execute:async()=>({stdout:'List of devices attached\ns1 device model:Phone\n'})});await inventory.refresh();assert.equal(s.assertLease(lease).token,lease.token);
});
