'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../service/store'),{createServer}=require('../service/server');
const token='test-only-token-not-a-real-credential-1234';
async function setup(t){const store=new Store();const server=createServer({store,token});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await new Promise(r=>server.close(r));store.close();});return {store,url:`http://127.0.0.1:${server.address().port}`};}
const request={schema_version:'crawler.request.v1',idempotency_key:'test',platform:'xiaohongshu',operation:'post.detail',targets:[{post_id:'n1'}]};
const headers={authorization:'Bearer '+token,'content-type':'application/json'};
test('authenticated submit, poll, results, events, and cancel',async t=>{
  const {url}=await setup(t);const accepted=await fetch(url+'/v1/requests',{method:'POST',headers,body:JSON.stringify(request)});assert.equal(accepted.status,202);const r=await accepted.json();
  const repeated=await (await fetch(url+'/v1/requests',{method:'POST',headers,body:JSON.stringify(request)})).json();assert.equal(repeated.id,r.id);
  assert.equal((await fetch(url+'/v1/requests/'+r.id,{headers})).status,200);
  const events=await (await fetch(url+'/v1/requests/'+r.id+'/events',{headers})).json();assert.equal(events.events[0].type,'request.accepted');
  assert.equal((await fetch(url+'/v1/requests/'+r.id+'/results?cursor=bad',{headers})).status,400);
  const cancelled=await (await fetch(url+'/v1/requests/'+r.id+'/cancel',{method:'POST',headers})).json();assert.equal(cancelled.state,'cancelled');
});
test('rejects missing credentials and direct browser origins without exposing request secrets',async t=>{
  const {url}=await setup(t);assert.equal((await fetch(url+'/v1/devices')).status,401);assert.equal((await fetch(url+'/v1/devices',{headers:{...headers,origin:'http://malicious'}})).status,403);
  const bad=await fetch(url+'/v1/requests',{method:'POST',headers,body:'secret malformed payload'});assert.equal(bad.status,400);assert.ok(!(await bad.text()).includes('secret'));
  const health=await (await fetch(url+'/health')).json();assert.equal(health.live_adapters,false);
});
test('request ownership enforced before lookup results',async t=>{
  const {url,store}=await setup(t);const r=store.submit(request,'other');assert.equal((await fetch(url+'/v1/requests/'+r.id+'/results',{headers})).status,404);
});
