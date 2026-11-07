'use strict';
const {digest}=require('./contract');
function resumePlan(claim,adapterVersion){
  const c=claim.checkpoint;
  const binding=digest({platform:claim.payload.platform,operation:claim.payload.operation,target:claim.target,params:claim.payload.params});
  if(!c)return {mode:'start',cursor:null,seen_ids:[],binding};
  if(c.binding!==binding)throw Object.assign(new Error('CHECKPOINT_MISMATCH'),{code:'CHECKPOINT_MISMATCH',scope:'item'});
  const same=c.device_id===claim.device_id && c.adapter_version===adapterVersion;
  return {mode:same?'cursor':'replay_deduplicate',cursor:same?c.cursor:null,seen_ids:c.seen_ids||[],binding};
}
module.exports={resumePlan};
