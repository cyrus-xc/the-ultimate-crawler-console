import copy
import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'adapters/xhs-phone'))
from ui_capture import UiResponseCapture, CaptureError, semantic_request
N='a'*24
CONTRACT={'http_method':'GET','path':'/api/sns/v1/note/imagefeed','allowed_hosts':['example.test'],
          'parameters':[{'name':'note_id','type':'java.lang.String'}]}

def wire(note=N,at=2):
    return {'event':'response_json','at':at,'request':{'method':'GET','host':'example.test','path':CONTRACT['path'],'query':[{'name':'note_id','value':note}]},
            'status':200,'body':{'code':0,'success':True,'data':[{'note_list':[{'id':note,'title':'raw interface body'}]}]},'at_peek_limit':False,'transport':{},'observation_id':'o1'}
class Script:
    def __init__(self):self.exports_sync=self;self.unloaded=False;self.calls=[]
    def on(self,event,callback):self.callback=callback
    def load(self):self.emit({'event':'observer_ready'})
    def emit(self,payload):self.callback({'type':'send','payload':payload},None)
    def allowpath(self,path):self.calls.append(('allowpath',path))
    def allowshare(self,note,path):self.calls.append(('allowshare',note))
    def takeshare(self,observation):return None
    def unload(self):self.unloaded=True
class Session:
    def __init__(self):self.scripts=[]
    def create_script(self,source):
        assert 'Java.perform' in source
        s=Script();self.scripts.append(s);return s
class CaptureTests(unittest.TestCase):
    def test_ui_trigger_retains_response_shape_without_active_agent(self):
        session=Session();clock=iter([1,3]);capture=UiResponseCapture(session,clock_ms=lambda:next(clock))
        result=capture.read('image_detail',CONTRACT,{'note_id':N},lambda:session.scripts[-1].emit(wire()))
        self.assertEqual(result['response']['data'][0]['note_list'][0]['title'],'raw interface body')
        self.assertEqual(result['trigger'],'ui');self.assertEqual(result['transport_evidence']['classification'],'unknown')
        self.assertTrue(session.scripts[0].unloaded)
    def test_unrelated_response_is_not_accepted(self):
        session=Session();capture=UiResponseCapture(session,clock_ms=lambda:2)
        with self.assertRaisesRegex(CaptureError,'CAPTURE_TIMEOUT'):
            capture.read('image_detail',CONTRACT,{'note_id':N},lambda:session.scripts[-1].emit(wire('b'*24)),timeout=0.005)
        self.assertTrue(session.scripts[0].unloaded)
    def test_stale_response_is_not_accepted(self):
        session=Session();capture=UiResponseCapture(session,clock_ms=lambda:2)
        with self.assertRaisesRegex(CaptureError,'CAPTURE_TIMEOUT'):
            capture.read('image_detail',CONTRACT,{'note_id':N},lambda:session.scripts[-1].emit(wire(at=1)),timeout=0.005)
    def test_matching_query_does_not_bypass_body_identity_check(self):
        session=Session();capture=UiResponseCapture(session,clock_ms=lambda:2);response=wire();response['body']['data'][0]['note_list'][0]['id']='b'*24
        with self.assertRaisesRegex(CaptureError,'IDENTITY_MISMATCH'):
            capture.read('image_detail',CONTRACT,{'note_id':N},lambda:session.scripts[-1].emit(response))
    def test_observer_rotates_for_every_action(self):
        session=Session();capture=UiResponseCapture(session,clock_ms=lambda:2)
        for _ in range(2):capture.read('image_detail',CONTRACT,{'note_id':N},lambda:session.scripts[-1].emit(wire()))
        self.assertEqual(len(session.scripts),2);self.assertTrue(all(s.unloaded for s in session.scripts))
    def test_capture_without_network_response_is_not_invented_from_ui(self):
        session=Session();capture=UiResponseCapture(session,clock_ms=lambda:2)
        with self.assertRaisesRegex(CaptureError,'CAPTURE_TIMEOUT'):
            capture.read('image_detail',CONTRACT,{'note_id':N},lambda:None,timeout=0.005)
    def test_app_filter_sort_is_validated_without_changing_raw_request(self):
        request={'query':[{'name':'sort','value':''},{'name':'filters','value':'[{"type":"sort_type","tags":["comment_descending"]}]'}]}
        original=copy.deepcopy(request)
        result=semantic_request(request,'search')
        self.assertEqual(next(q['value'] for q in result['query'] if q['name']=='sort'),'comment_descending')
        self.assertEqual(request,original)
    def test_latest_shortcut_is_not_chronological_sort(self):
        request={'query':[{'name':'sort','value':''},{'name':'filters','value':'[{"type":"filter_hot","tags":["最新"]}]'}]}
        result=semantic_request(request,'search')
        self.assertEqual(next(q['value'] for q in result['query'] if q['name']=='sort'),'general')
    def test_conflicting_sort_parameters_are_not_accepted(self):
        request={'query':[{'name':'sort','value':'general'},{'name':'filters','value':'[{"type":"sort_type","tags":["comment_descending"]}]'}]}
        result=semantic_request(request,'search')
        self.assertEqual(next(q['value'] for q in result['query'] if q['name']=='sort'),'__invalid_sort__')
    def test_search_ignores_residual_filters_and_keeps_original_packet(self):
        contract={**CONTRACT,'parameters':[{'name':'query','type':'java.util.Map'}]}
        filters='[{"type":"sort_type","tags":["time_descending"]},{"type":"filter_hot","tags":["最新"]}]'
        response=wire();response['request']['query']=[{'name':'keyword','value':'coffee'},{'name':'sort','value':''},{'name':'filters','value':filters}]
        session=Session();capture=UiResponseCapture(session,clock_ms=lambda:2)
        values={'query':{'keyword':'coffee','sort':'time_descending','filters':'[]'}}
        with self.assertRaisesRegex(CaptureError,'CAPTURE_TIMEOUT'):
            capture.read('search',contract,values,lambda:session.scripts[-1].emit(response),timeout=0.005)
        response['request']['query'][-1]['value']='[{"type":"sort_type","tags":["time_descending"]},{"type":"filter_hot","tags":["不限"]}]'
        result=capture.read('search',contract,values,lambda:session.scripts[-1].emit(response))
        self.assertEqual(result['request'],response['request'])
        self.assertEqual(result['effective_sort'],'time_descending')
        response['request']['query'][-1]['value']=response['request']['query'][-1]['value'].replace('不限','综合')
        result=capture.read('search',contract,values,lambda:session.scripts[-1].emit(response))
        self.assertEqual(result['effective_sort'],'time_descending')
if __name__=='__main__':unittest.main()
