import copy
import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'adapters/xhs-phone'))
from ui_capture import UiResponseCapture, CaptureError, semantic_request, posted_page_groups
from note_links import valid_note_url
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
    def test_share_link_restored_only_for_observed_matching_host_and_note(self):
        for host,accepted in [('www.xiaohongshu.com',True),('www.xiaohongshu.com.evil.test',False)]:
            session=Session();capture=UiResponseCapture(session,clock_ms=lambda:2)
            link='https://'+host+'/explore/'+N+'?xsec_token=fixture-only'
            def trigger():
                script=session.scripts[-1];script.takeshare=lambda observation:link;script.emit(wire())
            result=capture.read('image_detail',CONTRACT,{'note_id':N},trigger,valid_note_url=valid_note_url)
            note=result['response']['data'][0]['note_list'][0]
            self.assertEqual(note.get('share_info',{}).get('link'),link if accepted else None)
    def test_phone_clock_offset_preserves_fast_real_responses_without_changing_content_time(self):
        session=Session()
        original=session.create_script
        def script(source):
            value=original(source);value.observerclock=lambda:1000;return value
        session.create_script=script
        clock=iter([2000,2002,2003,2005]);capture=UiResponseCapture(session,clock_ms=lambda:next(clock))
        response=wire(at=1004);response['body']['data'][0]['note_list'][0]['time']=123
        result=capture.read('image_detail',CONTRACT,{'note_id':N},lambda:session.scripts[-1].emit(response))
        self.assertEqual(result['captured_at_ms'],2005)
        self.assertEqual(result['device_captured_at_ms'],1004)
        self.assertEqual(result['observer_clock_offset_ms'],1001)
        self.assertEqual(result['response']['data'][0]['note_list'][0]['time'],123)

    def test_profile_first_page_is_preserved_from_same_navigation_action(self):
        user_contract={**CONTRACT,'path':'/api/sns/v3/user/info','parameters':[{'name':'query','type':'java.util.Map'}]}
        posted_contract={**CONTRACT,'path':'/api/sns/v4/note/user/posted','parameters':[{'name':'user_id','type':'java.lang.String'},{'name':'cursor','type':'java.lang.String'}]}
        info={'event':'response_json','at':2,'request':{'method':'GET','host':'example.test','path':user_contract['path'],'query':[{'name':'user_id','value':N}]},'status':200,'body':{'code':0,'success':True,'data':{'userid':N}}}
        posted={'event':'response_json','at':2,'request':{'method':'GET','host':'example.test','path':posted_contract['path'],'query':[{'name':'user_id','value':N},{'name':'cursor','value':''}]},'status':200,'body':{'code':0,'success':True,'data':{'notes':[{'id':'b'*24,'user':{'userid':N}}],'has_more':False}}}
        session=Session();capture=UiResponseCapture(session,clock_ms=lambda:2)
        def trigger():
            session.scripts[-1].emit(info);session.scripts[-1].emit(posted)
        result=capture.read('user_info',user_contract,{'query':{'user_id':N}},trigger,related_contracts={'user_posted':posted_contract})
        self.assertEqual(result['related']['user_posted']['response']['data']['notes'][0]['id'],'b'*24)

    def test_profile_navigation_retains_prefetched_posted_pages(self):
        user_contract={**CONTRACT,'path':'/api/sns/v3/user/info','parameters':[{'name':'query','type':'java.util.Map'}]}
        posted_contract={**CONTRACT,'path':'/api/sns/v4/note/user/posted','parameters':[{'name':'user_id','type':'java.lang.String'},{'name':'cursor','type':'java.lang.String'}]}
        info={'event':'response_json','at':2,'request':{'method':'GET','host':'example.test','path':user_contract['path'],'query':[{'name':'user_id','value':N}]},'status':200,'body':{'code':0,'success':True,'data':{'userid':N}}}
        def posted(cursor,note):
            return {'event':'response_json','at':2,'request':{'method':'GET','host':'example.test','path':posted_contract['path'],'query':[{'name':'user_id','value':N},{'name':'cursor','value':cursor}]},'status':200,'body':{'code':0,'success':True,'data':{'notes':[{'id':note,'cursor':note,'user':{'userid':N}}],'has_more':True}}}
        session=Session();capture=UiResponseCapture(session,clock_ms=lambda:2)
        def trigger():
            for value in [info,posted('', 'b'*24),posted('unobserved-gap','d'*24),posted('b'*24,'c'*24)]:session.scripts[-1].emit(value)
        result=capture.read('user_info',user_contract,{'query':{'user_id':N}},trigger,related_contracts={'user_posted':posted_contract})
        first=result['related']['user_posted']
        self.assertEqual(first['response']['data']['notes'][0]['id'],'b'*24)
        self.assertEqual(len(first.get('related_pages',[])),1, 'profile navigation discarded a captured next page')
        self.assertEqual(first['related_pages'][0]['response']['data']['notes'][0]['id'],'c'*24)

    def test_navigation_failure_retains_safe_page_mismatch_diagnostics(self):
        contract={**CONTRACT,'path':'/api/sns/v4/note/user/posted','parameters':[{'name':'user_id','type':'java.lang.String'},{'name':'cursor','type':'java.lang.String'}]}
        response={'event':'response_json','at':2,'request':{'method':'GET','host':'example.test','path':contract['path'],'query':[{'name':'user_id','value':N},{'name':'cursor','value':'already-prefetched'},{'name':'xsec_token','value':'private-fixture'}]},'status':200,'body':{'code':0,'success':True,'data':{'notes':[],'has_more':False}}}
        session=Session();capture=UiResponseCapture(session,clock_ms=lambda:2)
        def trigger():
            session.scripts[-1].emit(response)
            raise CaptureError('PHONE_PAGE_RESPONSE_UNOBSERVED')
        with self.assertRaises(CaptureError) as caught:
            capture.read('user_posted',contract,{'user_id':N,'cursor':'expected'},trigger)
        self.assertEqual(str(caught.exception),'PHONE_PAGE_RESPONSE_UNOBSERVED')
        observed=caught.exception.diagnostics['observed_requests'][0]
        self.assertFalse(observed['requested_page_match'])
        self.assertTrue(observed['target_match_without_pagination'])
        self.assertNotIn('private-fixture',str(caught.exception.diagnostics))
        self.assertNotIn('already-prefetched',str(caught.exception.diagnostics))
        self.assertTrue(session.scripts[-1].unloaded)

    def test_response_feedback_stops_ui_loop_before_action_returns(self):
        session=Session();ready=[];capture=UiResponseCapture(session,clock_ms=lambda:2)
        def trigger():
            session.scripts[-1].emit(wire())
            self.assertEqual(ready,[True])
        capture.read('image_detail',CONTRACT,{'note_id':N},trigger,notify_response=lambda:ready.append(True))

    def test_prefetched_target_page_is_preserved_but_foreign_user_is_not(self):
        contract={**CONTRACT,'path':'/api/sns/v4/note/user/posted','parameters':[{'name':'user_id','type':'java.lang.String'},{'name':'cursor','type':'java.lang.String'}]}
        def posted(cursor,note,user=N):
            return {'event':'response_json','at':2,'request':{'method':'GET','host':'example.test','path':contract['path'],'query':[{'name':'user_id','value':user},{'name':'cursor','value':cursor}]},'status':200,'body':{'code':0,'success':True,'data':{'notes':[{'id':note,'cursor':'next' if cursor=='' else 'last','user':{'userid':user}}],'has_more':True}}}
        session=Session();capture=UiResponseCapture(session,clock_ms=lambda:2)
        def trigger():
            for value in [posted('', 'b'*24),posted('next','c'*24),posted('', 'e'*24,'d'*24)]:session.scripts[-1].emit(value)
        result=capture.read('user_posted',contract,{'user_id':N,'cursor':''},trigger)
        self.assertEqual(len(result['related_pages']),1)
        self.assertEqual(result['related_pages'][0]['response']['data']['notes'][0]['id'],'c'*24)

    def test_profile_replay_pages_are_retained_without_regressing_or_skipping_cursor(self):
        contract={**CONTRACT,'path':'/api/sns/v4/note/user/posted','parameters':[{'name':'user_id','type':'java.lang.String'},{'name':'cursor','type':'java.lang.String'}]}
        def posted(cursor,note,next_cursor,user=N):
            return {'event':'response_json','at':2,'request':{'method':'GET','host':'example.test','path':contract['path'],'query':[{'name':'user_id','value':user},{'name':'cursor','value':cursor}]},'status':200,'body':{'code':0,'success':True,'data':{'notes':[{'id':note,'cursor':next_cursor,'user':{'userid':user}}],'has_more':True}}}
        session=Session();capture=UiResponseCapture(session,clock_ms=lambda:2)
        def trigger():
            for value in [posted('', 'b'*24,'page2'),posted('page2','c'*24,'page3'),posted('page3','d'*24,'page4'),posted('unobserved-gap','e'*24,'gap-next'),posted('page4','f'*24,'wrong-next','0'*24)]:
                session.scripts[-1].emit(value)
        result=capture.read('user_posted',contract,{'user_id':N,'cursor':'page2'},trigger)
        self.assertEqual(result['response']['data']['notes'][0]['id'],'c'*24)
        self.assertEqual([p['response']['data']['notes'][0]['id'] for p in result['related_pages']],['d'*24])
        self.assertEqual([p['response']['data']['notes'][0]['id'] for p in result['replayed_pages']],['b'*24,'e'*24])

    def test_contiguous_profile_chain_retains_but_does_not_follow_cursor_cycles(self):
        def page(request,cursor):
            return {'request':{'query':[{'name':'cursor','value':request}]},'response':{'data':{'cursor':cursor,'notes':[],'has_more':True}}}
        for destination in ['a','b']:
            cyclic=page('b',destination)
            following,replayed=posted_page_groups(page('a','b')['response'],[cyclic],'a')
            self.assertEqual(following,[])
            self.assertEqual(replayed,[cyclic])
        valid=page('b','c');cyclic=page('c','b')
        following,replayed=posted_page_groups(page('a','b')['response'],[valid,cyclic],'a')
        self.assertEqual(following,[valid]);self.assertEqual(replayed,[cyclic])

    def test_standalone_access_tokens_are_removed_before_evidence_storage(self):
        from runtime_redaction import clean
        value=clean({'data':{'xsec_token':'fixture-only','xsecToken':'fixture-only','id':N}})
        self.assertEqual(value,{'data':{'id':N}})
if __name__=='__main__':unittest.main()

class DualDetailCaptureTests(unittest.TestCase):
    def test_one_click_accepts_registered_video_format_with_both_query_and_body_identity(self):
        video={**CONTRACT,'path':'/api/sns/v4/note/videofeed'}
        session=Session();capture=UiResponseCapture(session,clock_ms=lambda:2);response=wire();response['request']['path']=video['path'];clicks=[]
        response['body']['data']=response['body']['data'][0]['note_list']
        result=capture.read('image_detail',CONTRACT,{'note_id':N},lambda:(clicks.append(1),session.scripts[-1].emit(response)),related_contracts={'video_detail':video})
        self.assertEqual(len(clicks),1);self.assertEqual(result['response_operation'],'video_detail');self.assertEqual(result['operation'],'image_detail')
        response['body']['data'][0]['id']='b'*24
        with self.assertRaisesRegex(CaptureError,'IDENTITY_MISMATCH'):
            capture.read('image_detail',CONTRACT,{'note_id':N},lambda:session.scripts[-1].emit(response),related_contracts={'video_detail':video})
    def test_wrong_host_or_target_on_video_format_is_never_accepted(self):
        video={**CONTRACT,'path':'/api/sns/v4/note/videofeed'}
        for mutation in ['host','query']:
            session=Session();capture=UiResponseCapture(session,clock_ms=lambda:2);response=wire();response['request']['path']=video['path']
            if mutation=='host':response['request']['host']='wrong.test'
            else:response['request']['query'][0]['value']='b'*24
            with self.assertRaisesRegex(CaptureError,'CAPTURE_TIMEOUT'):
                capture.read('image_detail',CONTRACT,{'note_id':N},lambda:session.scripts[-1].emit(response),related_contracts={'video_detail':video},timeout=.005)
    def test_direct_video_payload_retains_only_the_observed_target_share_link(self):
        video={**CONTRACT,'path':'/api/sns/v4/note/videofeed'}
        session=Session();capture=UiResponseCapture(session,clock_ms=lambda:2);response=wire();response['request']['path']=video['path'];response['body']['data']=response['body']['data'][0]['note_list']
        link='https://www.xiaohongshu.com/explore/'+N+'?xsec_token=fixture-only'
        def trigger():
            session.scripts[-1].takeshare=lambda observation:link
            session.scripts[-1].emit(response)
        result=capture.read('image_detail',CONTRACT,{'note_id':N},trigger,related_contracts={'video_detail':video},valid_note_url=valid_note_url)
        self.assertEqual(result['response_operation'],'video_detail');self.assertEqual(result['response']['data'][0]['share_info']['link'],link)

class PrivateDiscoveryMediaTests(unittest.TestCase):
    def test_identity_field_host_and_redacted_value_binding(self):
        from response_evidence import private_media
        from runtime_redaction import clean
        url='https://sns-img.xhscdn.com/a%2Fb?sign=private%2Bsignature&t=1'
        note={'id':N,'images_list':[{'info_list':[{'url':clean(url)}]}]}
        result={'operation':'user_posted','response':{'data':{'notes':[note]}}}
        record={'note_id':N,'path':['images_list',0,'info_list',0,'url'],'url':url}
        self.assertEqual(private_media(result,[record]),[record])
        self.assertEqual(note['images_list'][0]['info_list'][0]['url'],clean(url))
        for change in ({'note_id':'b'*24},{'url':'https://evil.test/a?sign=private'}, {'path':['video','stream','url']},{'url':'https://sns-img.xhscdn.com/different?sign=private'}):
            self.assertEqual(private_media(result,[{**record,**change}]),[])
        detail={'operation':'image_detail','response_operation':'video_detail','note_id':N,'response':{'data':[note,{'id':'b'*24}]}}
        self.assertEqual(private_media(detail,[record]),[record])
        detail['note_id']='b'*24
        self.assertEqual(private_media(detail,[record]),[])

class CommentIdentityDiagnosticsTests(unittest.TestCase):
    def test_missing_reply_identity_is_distinguished_from_conflicting_identity(self):
        from ui_capture import verify_payload
        wire={'status':200,'body':{'code':0,'success':True,'data':{'comments':[{'note_id':N,'sub_comments':[{'id':'reply'}]}]}}}
        with self.assertRaises(CaptureError) as error:
            verify_payload('comments',{'note_id':N},wire,{})
        self.assertEqual(error.exception.diagnostics['comment_identity'],{'total':2,'missing':1,'different':0})
