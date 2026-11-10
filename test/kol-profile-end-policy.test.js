'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../service/store');
const {DiscoverySessions,normalize}=require('../service/discovery_sessions');
const {nativeRequest}=require('../adapters/xhs-web/adapter');
const user='a'.repeat(24),policy='observed_terminal_v1';
const query={schema_version:'crawler.discovery.v1',platform:'xiaohongshu',user_id:user,mode:'count',count:40,exclude_pinned:true};

function setup(t,kind='web'){
 const store=new Store();store.register({id:'web:xhs:default',kind,serial:kind==='android'?'fixture':undefined,
  capabilities:['profile.posts','post.detail'].map(operation=>({platform:'xiaohongshu',operation}))});
 const calls=[],adapter={execute:async ctx=>{
  calls.push(ctx.claim.payload.params);
  const feeds=Array.from({length:19},(_,i)=>({id:(i+1).toString(16).padStart(24,'0'),noteCard:{interactInfo:{sticky:false,likedCount:0}}}));
  ctx.commit({items:[{value:{phase:'result',data:{raw:{feeds,search:{hasMore:false},comments:{hasMore:false}},
   stop_reason:'no_growth',end_observed:false,profile_end_observation:{schema:'xhs_profile_end_observation_v1',
    terminal_decision:'unverified',tail_nodes:[{text:'THE END / 没有更多了'}]}}}}]});
 }};
 const sessions=new DiscoverySessions({store,adapters:new Map([['web:xhs:default',adapter]])});
 t.after(async()=>{await sessions.close();store.close();});return{sessions,calls};
}

test('KOL observation policy is explicit count-only; invalid or date requests fail closed',()=>{
 assert.equal(normalize({...query,profile_end_policy:policy},Date.now()).profile_end_policy,policy);
 assert.equal(normalize(query,Date.now()).profile_end_policy,undefined);
 for(const value of ['',true,'guess_the_end'])assert.throws(()=>normalize({...query,profile_end_policy:value},Date.now()),{code:'INVALID_PROFILE_END_POLICY'});
 assert.throws(()=>normalize({...query,mode:'date',count:undefined,startdate:'2026-01-01T00:00:00Z',exclude_pinned:undefined,profile_end_policy:policy},Date.now()),{code:'INVALID_PROFILE_END_POLICY'});
});

test('opt-in forwards only to Web, preserves existing read count, and retains only final observation without declaring end',async t=>{
 const normal=setup(t),observed=setup(t),native=setup(t,'android');
 const plain=await normal.sessions.open(query);
 const result=await observed.sessions.open({...query,profile_end_policy:policy});
 const phone=await native.sessions.open({...query,profile_end_policy:policy});
 assert.equal(observed.calls.length,normal.calls.length);
 assert.equal(observed.calls.length,2,'the existing count expansion remains unchanged');
 assert.ok(normal.calls.every(call=>call.native_request.profile_end_policy===undefined));
 assert.ok(observed.calls.every(call=>call.native_request.profile_end_policy===policy));
 assert.ok(native.calls.every(call=>call.native_request.profile_end_policy===undefined));
 assert.equal(plain.profile_end_observation,undefined);
 assert.equal(phone.profile_end_observation,undefined);
 assert.equal(result.profile_end_observation.terminal_decision,'unverified');
 assert.equal(result.coverage.end_observed,false,'short count/no growth/other-page markers do not prove profile end');
 assert.equal(result.coverage.stop_reason,'no_growth');
 for(const [sessions,value] of [[normal.sessions,plain],[observed.sessions,result],[native.sessions,phone]])await sessions.complete(value.session_id,{selected_ids:[]});
});

test('native Web request carries observation policy only for a bounded non-walk profile request',()=>{
 const request={target:{user_id:user},payload:{operation:'profile.posts',params:{max_items:40,native_request:{profile_end_policy:policy}},limits:{max_pages:5,execution_timeout_seconds:90}}};
 assert.equal(nativeRequest(request).profile_end_policy,policy);
 for(const value of ['',true,'guess'])assert.throws(()=>nativeRequest({...request,payload:{...request.payload,params:{native_request:{profile_end_policy:value}}}}),{code:'INVALID_PROFILE_END_POLICY'});
 const walking={...request,payload:{...request.payload,params:{native_request:{profile_end_policy:policy,profile_walk:true,target:0}}}};
 assert.throws(()=>nativeRequest(walking),{code:'INVALID_PROFILE_END_POLICY'});
});
