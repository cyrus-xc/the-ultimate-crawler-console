'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const {spawnSync}=require('node:child_process');
const {envelope}=require('../adapters/xhs-phone/projection');
test('real capture classification excludes NPS questionnaires from projected comments without losing raw evidence',()=>{
 const root=path.resolve(__dirname,'..'),fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/nps-comments.json'),'utf8'));
 const program=`import copy,json,sys
from pathlib import Path
sys.path.insert(0,'test')
from test_ui_capture import Session,UiResponseCapture,CONTRACT,N
packet=json.loads(Path('test/fixtures/nps-comments.json').read_text())
packet['body']['data']['comments'][0]['sub_comments'].append(copy.deepcopy(packet['body']['data']['comments'][1]))
session=Session()
result=UiResponseCapture(session,clock_ms=lambda:2).read('comments',{**CONTRACT,'path':'/comments'},{'note_id':N},lambda:session.scripts[-1].emit(packet),timeout=.01)
print(json.dumps(result))`;
 const captured=spawnSync(process.env.PYTHON||'python',['-B','-c',program],{cwd:root,encoding:'utf8',env:{...process.env,ENABLE_TIKHUB_NETWORK:'0',ENABLE_LLM_NETWORK:'0'}});
 assert.equal(captured.status,0,captured.stderr);const result=JSON.parse(captured.stdout);
 const before=structuredClone(result.response),value=envelope(result,'post.comments',{post_id:'a'.repeat(24)});
 assert.equal(value.data.raw.comments.list.length,1);
 assert.equal(value.data.raw.comments.list[0].subComments.length,1);
 assert.equal(value.data.non_comment_count,2);
 assert.equal(value.data.end_observed,true);assert.equal(value.data.stop_reason,'native_end_observed');
 assert.notEqual(value.data.comments_complete,false);
 assert.deepEqual(value.data.response,before);assert.deepEqual(result.response,before);
 assert.deepEqual(result.response.data.comments[1],fixture.body.data.comments[1]);
 assert.equal(value.data.native_evidence[0].non_comment_count,2);
});
