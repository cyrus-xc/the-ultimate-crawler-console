"use strict";
const {LocalWorker}=require('./worker');
// SQLite owns ordering/leases. This loop is only a wakeup mechanism; restart does
// not reset dispatch order or assume expired input processes have stopped.
class Scheduler {
  constructor(store,adapters,{pollMs=100,onError=()=>{},...workerOptions}={}) {
    if(!Number.isInteger(pollMs)||pollMs<1)throw new TypeError('Invalid scheduler interval');
    this.store=store;this.worker=new LocalWorker(store,adapters,workerOptions);
    this.pollMs=pollMs;this.onError=onError;this.timer=null;this.closing=false;
  }
  tick(){if(this.closing)return 0;this.store.expire();return this.worker.dispatch();}
  start(){
    if(this.closing)throw new Error('SCHEDULER_CLOSED');
    if(this.timer)return this;
    const wake=()=>{try{this.tick();}catch(error){this.lastError=error.code||'SCHEDULER_FAILED';this.onError(error);}};
    this.timer=setInterval(wake,this.pollMs);wake();return this;
  }
  async close(){this.closing=true;clearInterval(this.timer);this.timer=null;await this.worker.close();}
}
module.exports={Scheduler};
