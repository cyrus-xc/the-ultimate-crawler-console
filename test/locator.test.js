'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {UiLocator}=require('../android/ui_locator');
const node=(id,text='搜索')=>({'resource-id':id,text,class:'android.widget.ImageView',center:[100,20]});
test('changed control ID self-heals only after semantic match and observed postcondition',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'locator-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const a=new UiLocator({root,serial:'one',appVersion:'9.51.0'});a.confirm(a.locate('search.open',[node('old-id')]),'search_input_visible');
 const b=new UiLocator({root,serial:'one',appVersion:'9.51.0'});const replacement=b.locate('search.open',[node('new-id')]);assert.ok(replacement.recovered);
 assert.equal(JSON.parse(fs.readFileSync(b.file)).bindings['search.open'].selector.resource_id,'old-id');
 b.confirm(replacement,'search_input_visible');assert.equal(JSON.parse(fs.readFileSync(b.file)).bindings['search.open'].selector.resource_id,'new-id');
});
test('obfuscated IDs not treated as unique stable identity',()=>{
 const l=new UiLocator({serial:'a',appVersion:'v'});const c=l.locate('search.open',[node('0_resource_name_obfuscated'),node('0_resource_name_obfuscated','其他')]);assert.equal(c.signature.resource_id,null);
});
test('cached ID with changed meaning is rejected and ambiguous controls do not update bindings',()=>{
 const l=new UiLocator({serial:'a',appVersion:'v'});l.confirm(l.locate('search.open',[node('id')]),'search_input_visible');
 assert.throws(()=>l.locate('search.open',[node('id','删除')]),{code:'UI_CONTROL_NOT_FOUND'});
 assert.throws(()=>l.locate('search.open',[node('id'),node('id2')]),{code:'UI_CONTROL_AMBIGUOUS'});assert.equal(l.bindings['search.open'].revision,1);
});
test('device and app version keep separate control scopes',()=>{
 const a=new UiLocator({serial:'a',appVersion:'v'}),b=new UiLocator({serial:'b',appVersion:'v'}),c=new UiLocator({serial:'a',appVersion:'v2'});assert.notEqual(a.scope,b.scope);assert.notEqual(a.scope,c.scope);
});
test('sort self-heal requires observed response sort confirmation',()=>{
 const l=new UiLocator({serial:'a',appVersion:'v'});const c=l.locate('sort.time_descending',[node('id','最新')]);assert.throws(()=>l.confirm(c,'search_text_verified'),{code:'CONTROL_POSTCONDITION_MISMATCH'});l.confirm(c,'response_sort_verified');
});

test('results-page query text identified structurally without persisting query text',()=>{
 const l=new UiLocator({serial:'a',appVersion:'v'});const nodes=[{...node('x','返回'),center:[20,100]}, {...node('x','全部删除'),center:[200,100]}, {...node('x','搜索'),center:[250,100]}, {...node('x','private query'),class:'android.widget.TextView',clickable:'true',center:[100,100]}, {...node('x','feed title'),class:'android.widget.TextView',clickable:'true',center:[100,700]}];
 const c=l.locate('search.query',nodes);assert.equal(c.node.text,'private query');l.confirm(c,'search_input_visible');assert.ok(!JSON.stringify(l.bindings).includes('private query'));
});

test('expanded sort menu disambiguates duplicated general/latest shortcuts using menu anchors',()=>{
 const l=new UiLocator({serial:'a',appVersion:'v'});const n=(text,y)=>({...node('0_resource_name_obfuscated',text),center:[100,y]});const nodes=[n('综合',580),n('最新',580),n('综合',706),n('最新',706),n('最多点赞',706),n('最多收藏',871)];
 assert.equal(l.locate('sort.general',nodes).node.center[1],706);assert.equal(l.locate('sort.time_descending',nodes).node.center[1],706);
});

test('expanded menu excludes lower underlying quick sort controls after layout shifts',()=>{
 const l=new UiLocator({serial:'a',appVersion:'v'}),n=(text,y)=>({...node('0_resource_name_obfuscated',text),center:[100,y],height:120});
 const nodes=[n('综合',1662),n('最新',1662),n('综合',706),n('最新',706),n('最多点赞',706),n('最多评论',706),n('最多收藏',871),n('重置',2256)];
 assert.equal(l.locate('sort.time_descending',nodes).node.center[1],706);assert.equal(l.locate('sort.reset',nodes).node.center[1],2256);
 assert.throws(()=>l.locate('sort.time_descending',[...nodes,n('最新',706)]),{code:'UI_CONTROL_AMBIGUOUS'});
});
test('observed English Redmi controls retain the same five semantic sort roles',()=>{
 const l=new UiLocator({serial:'redmi',appVersion:'9.51.0'}),n=(text,y)=>({...node('0_resource_name_obfuscated',text),center:[100,y],height:80});
 const nodes=[n('Top',420),n('Latest',420),n('Top',514),n('Latest',514),n('Most liked',514),n('Most commented',635),n('Most saved',635),n('Clear',1775)];
 for(const [role,label] of Object.entries({general:'Top',time_descending:'Latest',popularity_descending:'Most liked',comment_descending:'Most commented',collect_descending:'Most saved'}))assert.equal(l.locate('sort.'+role,nodes).node.text,label);
 assert.equal(l.locate('filter.quick_general',nodes).node.center[1],420);assert.equal(l.locate('sort.reset',nodes).node.text,'Clear');
});
