'use strict';
// Synthetic DOM observation fixtures. These are deliberately NOT evidence of
// the live profile's terminal markup and never make a positive end decision.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const script=fs.readFileSync(path.join(__dirname,'../adapters/xhs-web/xiaohongshu-mcp/xiaohongshu/profile_end_observation.js'),'utf8');
const uid='a'.repeat(24),note='b'.repeat(24);
function element(tag,classes=[],text='',attributes={}){
 const node={tagName:tag.toUpperCase(),classList:classes,innerText:text,attributes,children:[],parentElement:null,
  style:{display:'block',visibility:'visible'},box:{width:100,height:30,top:200,bottom:230,left:0,right:100},
  getBoundingClientRect(){return this.box;},getAttribute(name){return this.attributes[name]??null;},querySelector(selector){return selector==='a.cover'?this.children.find(child=>child.classList.includes('cover')):null;}};
 Object.defineProperty(node,'nextElementSibling',{get(){const siblings=this.parentElement?.children||[];return siblings[siblings.indexOf(this)+1]||null;}});
 return node;
}
function append(parent,...children){for(const child of children){child.parentElement=parent;parent.children.push(child);}return parent;}
function fixture({tail='THE END',loading=false,pathUid=uid,hidden=false}={}){
 const body=element('body'),list=element('div',['feeds-container']),card=element('section',['note-item']);
 append(card,element('a',['cover'],'',{href:`/explore/${note}?xsec_token=PRIVATE_ACCESS`}));
 const end=element('div',['unverified-tail'],tail);if(hidden)end.style.display='none';
 const spinner=element('div',['spinner'],'',{role:'progressbar','aria-busy':'true'});if(!loading)spinner.style.display='none';
 append(body,append(list,card,end),spinner);
 const context={window:{__INITIAL_STATE__:{user:{activeTab:{value:{index:0,query:'note'}},loading:{value:loading},access_token:'PRIVATE_STATE'}}},
  location:{pathname:'/user/profile/'+pathUid},innerHeight:800,innerWidth:1200,
  getComputedStyle:node=>node.style,document:{querySelectorAll:selector=>selector==='section.note-item'?[card]:[spinner]}};
 return JSON.parse(vm.runInNewContext(script,context)(uid));
}

test('short list, geometric bottom and other pages terminal words remain unverified observations',()=>{
 for(const tail of ['THE END','没有更多了','评论已到底','search hasMore=false','profile no_growth']){
  const result=fixture({tail});
  assert.equal(result.terminal_decision,'unverified');
  assert.equal(result.profile_uid_matches,true);assert.equal(result.active_tab.query,'note');
  assert.equal(result.identified_card_count,1);assert.equal(result.last_card.note_id,note);
  assert.equal(result.tail_nodes[0].text,tail);
  assert.equal(result.end_observed,undefined,'the observation never declares end');
 }
});
test('tail evidence strips URL, query credentials, bearer and standalone token fields',()=>{
 const result=fixture({tail:'尾部 https://example.test/?xsec_token=PRIVATE_URL xsec_token=PRIVATE_QUERY authorization: Bearer PRIVATE_AUTH Bearer PRIVATE_BEARER'});
 const serialized=JSON.stringify(result);
 for(const secret of ['PRIVATE_','https://','xsec_token=','Bearer '])assert.equal(serialized.includes(secret),false,serialized);
 assert.ok(result.tail_nodes[0].text.includes('<URL>'));
 assert.ok(result.tail_nodes[0].text.includes('<REDACTED>'));
 assert.ok(result.last_card.css_path.includes('section.note-item'));
});
test('current page identity, loading and visibility are reported without deciding a terminal signal',()=>{
 const loading=fixture({loading:true,pathUid:'c'.repeat(24)});
 assert.equal(loading.profile_uid_matches,false);assert.equal(loading.state_loading.loading,true);
 assert.equal(loading.loading_nodes.length,1);assert.equal(loading.terminal_decision,'unverified');
 assert.equal(fixture({hidden:true}).tail_nodes.length,0);
 assert.deepEqual(fixture({loading:false}).loading_nodes,[]);
});
