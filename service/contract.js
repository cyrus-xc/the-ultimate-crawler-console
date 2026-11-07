'use strict';
const {createHash} = require('node:crypto');
const VERSION = 'crawler.request.v1';
const OPERATIONS = ['search.posts', 'profile.get', 'profile.posts', 'post.detail', 'post.comments', 'place.search', 'place.posts', 'link.resolve'];
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const canonical = x => JSON.stringify(sort(x));
function sort(x) {
  if (Array.isArray(x)) return x.map(sort);
  return object(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, sort(x[k])])) : x;
}
const digest = x => createHash('sha256').update(canonical(x)).digest('hex');
function problem(code, status=400) { return Object.assign(new Error(code), {code, status}); }
function keys(value, allowed) {
  if (!object(value) || Object.keys(value).some(k => !allowed.includes(k))) throw problem('INVALID_REQUEST');
}
function integer(n, min, max) { if (!Number.isSafeInteger(n) || n < min || n > max) throw problem('INVALID_LIMIT'); return n; }
function identifier(x) { return typeof x === 'string' && x.length > 0 && x.length <= 512 && !/[\x00-\x1f]/.test(x); }
function normalize(input) {
  keys(input, ['schema_version','idempotency_key','platform','operation','effort','targets','params','limits','routing','cache','context','continuation']);
  if (input.schema_version !== VERSION || !identifier(input.idempotency_key)) throw problem('INVALID_REQUEST');
  if (!['xiaohongshu','douyin'].includes(input.platform) || !OPERATIONS.includes(input.operation)) throw problem('UNSUPPORTED_OPERATION');
  if (!['full','half','auto'].includes(input.effort || 'auto')) throw problem('INVALID_EFFORT');
  if (!Array.isArray(input.targets) || !input.targets.length || input.targets.length > 1000) throw problem('INVALID_TARGETS');
  const key = {'search.posts':'keyword','place.search':'keyword','profile.get':'user_id','profile.posts':'user_id','post.detail':'post_id','post.comments':'post_id','place.posts':'place_id','link.resolve':'url'}[input.operation];
  const targets = input.targets.map(t => {
    keys(t,[key,'observed_url']);
    if (!identifier(t[key])) throw problem('INVALID_TARGET');
    // Identity/host validation of access URLs belongs to the platform adapter.
    if (t.observed_url !== undefined && (typeof t.observed_url !== 'string' || t.observed_url.length > 16384)) throw problem('INVALID_TARGET');
    return t;
  });
  const params = input.params || {};
  const allowed = {
    'search.posts':['max_items','sort','filters'], 'profile.get':[],
    'profile.posts':['max_items','published_after','published_before'],
    'post.detail':[], 'post.comments':['max_items','include_replies'],
    'place.search':['max_items','locator'], 'place.posts':['max_items','sort','locator'], 'link.resolve':[]
  }[input.operation];
  keys(params,[...allowed,'native_request']);
  if(params.native_request!==undefined){
    keys(params.native_request,['kind','id','keyword','xsec_token','target','seconds','comments','comment_mode','comment_lazy_load_limit','sort_by','since','profile_walk','profile_walk_version','profile_anchor_ids','profile_skip_ids','capture_share','select_share','user_id','representation']);
    if(params.native_request.representation!==undefined&&!['share_page','mobile_metadata','mobile_detail','ui_identity'].includes(params.native_request.representation))throw problem('INVALID_PARAMS');
    if(params.native_request.representation!==undefined&&input.operation!=='post.detail')throw problem('INVALID_PARAMS');
    if(['share_page','mobile_metadata','mobile_detail'].includes(params.native_request.representation)&&input.platform!=='xiaohongshu')throw problem('INVALID_PARAMS');
    if(Buffer.byteLength(JSON.stringify(params.native_request))>262144)throw problem('INVALID_PARAMS');
  }
  if(params.locator!==undefined){keys(params.locator,['names','seed_post']);if(!Array.isArray(params.locator.names)||!params.locator.names.length||params.locator.names.length>30||params.locator.names.some(x=>!identifier(x))||(params.locator.seed_post!==undefined&&!identifier(params.locator.seed_post)))throw problem('INVALID_PARAMS');}
  if ('max_items' in params) integer(params.max_items,1,100000);
  for (const k of ['published_after','published_before']) if (k in params &&
    (typeof params[k] !== 'string' || !/(?:Z|[+-]\d\d:\d\d)$/.test(params[k]) || !Number.isFinite(Date.parse(params[k])))) throw problem('INVALID_TIME');
  if (params.published_after && params.published_before && Date.parse(params.published_after)>Date.parse(params.published_before)) throw problem('INVALID_TIME_RANGE');
  if ('include_replies' in params && typeof params.include_replies !== 'boolean') throw problem('INVALID_PARAMS');
  if ('sort' in params && !identifier(params.sort)) throw problem('INVALID_PARAMS');
  if ('filters' in params && !object(params.filters)) throw problem('INVALID_PARAMS');
  const limits = {max_pages:20,execution_timeout_seconds:600,queue_timeout_seconds:1800,...input.limits};
  keys(limits,['max_pages','execution_timeout_seconds','queue_timeout_seconds']);
  integer(limits.max_pages,1,1000); integer(limits.execution_timeout_seconds,1,86400); integer(limits.queue_timeout_seconds,1,604800);
  const routing = {kinds:['web','android'],device_ids:[],...input.routing};
  keys(routing,['kinds','device_ids']);
  if (!Array.isArray(routing.kinds) || !routing.kinds.length || routing.kinds.some(k=>!['web','android'].includes(k)) ||
    !Array.isArray(routing.device_ids) || routing.device_ids.some(id=>!identifier(id))) throw problem('INVALID_ROUTING');
  const cache = {mode:'prefer_fresh',max_age_seconds:3600,...input.cache};
  keys(cache,['mode','max_age_seconds']);
  if (!['prefer_fresh','refresh','only'].includes(cache.mode)) throw problem('INVALID_CACHE');
  integer(cache.max_age_seconds,0,31536000);
  const context = input.context || {};
  keys(context,['pipeline','run_id','stage','source_revision']);
  if (Object.values(context).some(x=>!identifier(x))) throw problem('INVALID_CONTEXT');
  if(input.continuation!==undefined){
    keys(input.continuation,['mode','timeout_seconds']);
    if(!['automatic','manual'].includes(input.continuation.mode))throw problem('INVALID_CONTINUATION');
    if(input.continuation.timeout_seconds!==undefined)integer(input.continuation.timeout_seconds,1,3600);
  }
  const unique = [...new Map(targets.map(t=>[canonical(t),t])).values()];
  return {...input,effort:input.effort||'auto',targets:unique,params,limits,routing,cache,context};
}
function parallelism(effort, available, competing=false) {
  if (!available) return 0;
  if (effort==='full') return available;
  if (effort==='half') return Math.ceil(available/2);
  // Owner-approved: a single compatible resource can run auto work.
  return available===1 ? 1 : Math.max(1,available-(competing && available>2 ? 2 : 1));
}
module.exports = {VERSION,OPERATIONS,canonical,digest,problem,normalize,parallelism,identifier,object};
