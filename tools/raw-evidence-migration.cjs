'use strict';
// Offline operator tool. Plans contain identities/digests only; source bodies stay in SQLite.
const fs=require('node:fs'),path=require('node:path');
const {canonical}=require('../service/contract');
const {planQueue,applyQueue,recoverQueue,manifest}=require('../service/raw_migration');
const {RawEvidenceStore}=require('../service/raw_evidence');
function main(argv){
 const action=argv.shift(),options={};
 while(argv.length){const key=argv.shift();if(!key.startsWith('--')||Object.hasOwn(options,key))throw Error('RAW_MIGRATION_ARGUMENTS_INVALID');if(key==='--rollback-committed')options[key]=true;else{const value=argv.shift();if(!value||value.startsWith('--'))throw Error('RAW_MIGRATION_ARGUMENTS_INVALID');options[key]=value;}}
 const allowed={plan:['--database','--output','--after','--limit','--max-bytes'],apply:['--database','--plan','--backup-root'],recover:['--database','--backup-root','--plan-id','--rollback-committed']};
 if(!allowed[action]||Object.keys(options).some(key=>!allowed[action].includes(key)))throw Error('RAW_MIGRATION_ARGUMENTS_INVALID');
 const required=key=>{if(typeof options[key]!=='string')throw Error('RAW_MIGRATION_ARGUMENTS_INVALID');return options[key];};
 const write=(file,value)=>{const absolute=path.resolve(file);for(let p=absolute;;p=path.dirname(p)){try{if(fs.lstatSync(p).isSymbolicLink())throw Error('RAW_MIGRATION_SYMLINK');}catch(error){if(error.code!=='ENOENT')throw error;}if(p===path.dirname(p))break;}const fd=fs.openSync(absolute,'wx',0o600);try{fs.writeFileSync(fd,canonical(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
 if(action==='plan'){
  const plan=planQueue(required('--database'),{after:Number(options['--after']??0),limit:Number(options['--limit']??250),maxBytes:Number(options['--max-bytes']??33554432)});
  write(required('--output'),{...manifest(plan),id:plan.id});return {plan_id:plan.id,rows:plan.rows.length,conflicts:plan.conflicts.length,next:plan.last,done:plan.done};
 }
 const database=required('--database'),store=new RawEvidenceStore(),backupRoot=required('--backup-root');
 if(action==='apply'){
  const expected=JSON.parse(fs.readFileSync(required('--plan'),'utf8'));
  const plan=planQueue(database,{after:expected.after,limit:Math.max(1,expected.scanned),maxBytes:Number.MAX_SAFE_INTEGER});
  if(canonical({...manifest(plan),id:plan.id})!==canonical(expected))throw Error('RAW_MIGRATION_PLAN_CHANGED');
  const receipt=applyQueue(database,plan,{store,backupRoot});return {plan_id:receipt.plan_id,status:receipt.status,rows:receipt.rows.length,next:receipt.last,done:receipt.done,backup:receipt.backup};
 }
 const receipt=recoverQueue(database,{store,backupRoot,planId:required('--plan-id'),rollbackCommitted:options['--rollback-committed']===true});return {plan_id:receipt.plan_id,status:receipt.status,rows:receipt.rows.length,next:receipt.after};
}
if(require.main===module){try{process.stdout.write(canonical(main(process.argv.slice(2)))+'\n');}catch(error){process.stderr.write(/^RAW_[A-Z_]+$/.test(error.code||error.message)?(error.code||error.message)+'\n':'RAW_MIGRATION_FAILED\n');process.exitCode=1;}}
module.exports={main};
