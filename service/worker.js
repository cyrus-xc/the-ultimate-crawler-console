'use strict';
const {resumePlan}=require('./resume');
// Adapters must resolve/reject only after their child processes and input writers
// have stopped. An unresolved adapter remains quarantined, never silently freed.
class LocalWorker {
  constructor(store,adapters,{heartbeatMs=5000,stopTimeoutMs=10000}={}) {
    this.store=store;this.adapters=adapters;this.heartbeatMs=heartbeatMs;this.stopTimeoutMs=stopTimeoutMs;this.active=new Map();this.stoppers=new Map();this.closing=false;
  }
  dispatch() {
    if(this.closing)return 0;
    let count=0,claim;
    while((claim=this.store.claim({deviceIds:[...this.adapters.keys()]}))) {
      const adapter=this.adapters.get(claim.device_id);
      if(!adapter){this.store.fail(claim,{code:'ADAPTER_UNAVAILABLE',scope:'device'});continue;}
      const attemptId=claim.attempt_id;
      const execution=this.execute(claim,adapter);this.active.set(attemptId,execution);
      execution.then(()=>this.active.delete(attemptId),error=>{this.active.delete(attemptId);this.lastError=error.code||'WORKER_FAILED';});count++;
    }
    return count;
  }
  async execute(claim,adapter) {
    const controller=new AbortController();let stopping=false,timeout,drained=false;let decisionPending=false,businessStopped=false;
    let timeoutReject;const stopDeadline=new Promise((_,reject)=>{timeoutReject=reject;});stopDeadline.catch(()=>{});
    const stop=(reason)=>{if(stopping)return;stopping=true;controller.abort(reason);
      timeout=setTimeout(()=>{
        if(drained)return;
        // Retain lease until expiry and mark unavailable immediately; supervisor
        // must confirm process death before this physical device can be reused.
        this.store.quarantine(claim.device_id);
        timeoutReject(Object.assign(Error('WORKER_STOP_TIMEOUT'),{code:'WORKER_STOP_TIMEOUT'}));
      },this.stopTimeoutMs);
    };
    this.stoppers.set(claim.attempt_id,stop);
    const guard=()=>{
      if(controller.signal.aborted)throw controller.signal.reason;
      this.store.active(claim);
      if(this.store.db.prepare('SELECT quarantined FROM devices WHERE id=?').get(claim.device_id)?.quarantined)throw Object.assign(Error('DEVICE_QUARANTINED'),{code:'DEVICE_QUARANTINED'});
      const r=this.store.request(claim.request_id);
      if(['pausing','cancelling'].includes(r.state)||this.closing){stop(Object.assign(new Error('STOP_REQUESTED'),{code:'STOP_REQUESTED'}));throw controller.signal.reason;}
      const unit=this.store.db.prepare('SELECT started FROM units WHERE id=?').get(claim.unit_id);
      if(this.store.now()-unit.started>=claim.payload.limits.execution_timeout_seconds*1000){stop(Object.assign(new Error('EXECUTION_DEADLINE'),{code:'EXECUTION_DEADLINE',scope:'item'}));throw controller.signal.reason;}
    };
    const interval=setInterval(()=>{
      if(stopping)return;
      try{guard();this.store.heartbeat(claim.lease);}catch(e){stop(e);}
    },this.heartbeatMs);
    try {
      const resume=resumePlan(claim,adapter.version);
      const context={claim,resume,signal:controller.signal,guard,
        // Check the fence immediately before EVERY input, not only before execute().
        input:async fn=>{guard();if(businessStopped)throw Object.assign(Error('BUSINESS_STOPPED'),{code:'BUSINESS_STOPPED',scope:'item'});if(decisionPending)throw Object.assign(Error('BUSINESS_DECISION_REQUIRED'),{code:'BUSINESS_DECISION_REQUIRED',scope:'item'});if(this.store.db.prepare('SELECT state FROM units WHERE id=?').get(claim.unit_id).state!=='running')throw Object.assign(Error('BUSINESS_DECISION_REQUIRED'),{code:'BUSINESS_DECISION_REQUIRED',scope:'item'});return await fn();},
        waitForDecision:async()=>{
          if(claim.payload.continuation?.mode!=='manual')return 'continue';
          guard();const d=this.store.requestDecision(claim);
          while(true){
            guard();const current=this.store.decision(d.id);if(current.action){decisionPending=false;businessStopped=current.action==='stop';return current.phase==='page'?current.action:{action:current.action,capture_share:current.capture_share,phase:current.phase,subject_id:current.subject_id};}
            if(current.deadline<=this.store.now())throw Object.assign(Error('BUSINESS_DECISION_TIMEOUT'),{code:'BUSINESS_DECISION_TIMEOUT',scope:'item'});
            await new Promise(resolve=>setTimeout(resolve,50));
          }
        },
        commit:page=>{guard();if(decisionPending||businessStopped)throw Object.assign(Error('BUSINESS_DECISION_REQUIRED'),{code:'BUSINESS_DECISION_REQUIRED',scope:'item'});this.store.commit(claim,{...page,done:false});decisionPending=claim.payload.continuation?.mode==='manual';}};
      // A process/device restart cannot bypass an unresolved local decision.
      if(claim.checkpoint&&claim.payload.continuation?.mode==='manual'){
        decisionPending=true;context.resumeDecision=await context.waitForDecision();
      }
      if(!businessStopped){
        const execution=Promise.resolve(adapter.execute(context));
        execution.then(()=>{drained=true;},()=>{drained=true;});
        await Promise.race([execution,stopDeadline]);
      }
      if(decisionPending)throw Object.assign(Error('BUSINESS_DECISION_REQUIRED'),{code:'BUSINESS_DECISION_REQUIRED',scope:'item'});
      drained=true;
      if(stopping)throw controller.signal.reason;
      guard();
      const checkpoint=this.store.request(claim.request_id).units.find(u=>u.id===claim.unit_id).checkpoint;
      this.store.commit(claim,{checkpoint,done:true});
    } catch(e) {
      if(e.code==='WORKER_STOP_TIMEOUT')return;
      if(e.code==='DEVICE_COMMAND_ACTIVE'){this.store.quarantine(claim.device_id,'DEVICE_COMMAND_ACTIVE');return;}
      drained=true;
      try {
        const r=this.store.request(claim.request_id);
        if(['pausing','cancelling'].includes(r.state))this.store.stopped(claim);
        else if(this.closing && e.code==='STOP_REQUESTED')this.store.yield(claim);
        else this.store.fail(claim,{code:e.code||'ADAPTER_FAILED',scope:['item','device','platform'].includes(e.scope)?e.scope:'device'});
      }catch(lost){if(lost.code==='DEVICE_COMMAND_ACTIVE'){this.store.quarantine(claim.device_id,'DEVICE_COMMAND_ACTIVE');return;}if(!['LEASE_LOST','ATTEMPT_LOST'].includes(lost.code))throw lost;}
    } finally {clearInterval(interval);clearTimeout(timeout);this.stoppers.delete(claim.attempt_id);}
  }
  async close(){this.closing=true;for(const stop of this.stoppers.values())stop(Object.assign(Error('STOP_REQUESTED'),{code:'STOP_REQUESTED'}));await Promise.all(this.active.values());}
}
module.exports={LocalWorker};
