import unittest,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'adapters/douyin-web'))
from douyin_web.transport import Transport,ReadError
class Fake(Transport):
    def __init__(self,bodies):self.bodies=iter(bodies);self.calls=[]
    def api(self,path,params):self.calls.append((path,params));return next(self.bodies)
    def goto(self,url):pass
class WorkerTransportTests(unittest.TestCase):
    def test_profile_metadata_is_observed_before_posts(self):
        t=Fake([{'user':{'sec_uid':'u'}},{'aweme_list':[{'aweme_id':'1','author':{'sec_uid':'u'}}],'has_more':False}]);pages=[]
        t.pages('profile.posts',{'user_id':'u'},max_items=5,max_pages=2,include_profile=True,on_page=pages.append)
        self.assertEqual(pages[0]['body']['user']['sec_uid'],'u');self.assertEqual(pages[1]['items'][0]['aweme_id'],'1')
    def test_mix_view_response_stays_raw_and_stop_prevents_more_fetch(self):
        t=Fake([{'mix_infos':[{'mix_id':'m'}]},{'aweme_list':[{'aweme_id':'1','statistics':{'play_count':12}}],'cursor':20,'has_more':True}]);pages=[]
        def observe(p):pages.append(p);return 'stop' if len(pages)==2 else 'continue'
        t.mix_views('u',on_page=observe)
        self.assertEqual(len(t.calls),2);self.assertEqual(pages[1]['endpoint'],'aweme_v1_web_mix_aweme');self.assertEqual(pages[1]['items'][0]['statistics']['play_count'],12)
    def test_wrong_metadata_identity_is_rejected(self):
        t=Fake([{'user':{'sec_uid':'other'}}])
        with self.assertRaisesRegex(ReadError,'PROFILE_IDENTITY_MISMATCH'):t.pages('profile.posts',{'user_id':'u'},max_items=5,max_pages=2,include_profile=True)
class LoginStateTests(unittest.TestCase):
    def test_stale_cookies_cannot_authenticate_blank_or_visible_login_page(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        from douyin_web.browser import DouyinBrowser
        browser=DouyinBrowser(None)
        browser.cookies=lambda:{'sessionid':'test-stale-cookie'}
        page=SimpleNamespace(url='about:blank',evaluate=lambda script:'complete' if 'readyState' in script else None,get_by_text=lambda *a,**k:SimpleNamespace(all=lambda:[]))
        browser.page=page
        with patch('douyin_web.guard.check',return_value=None):
            self.assertFalse(browser.is_logged_in())
            page.url='https://www.douyin.com/'
            page.get_by_text=lambda *a,**k:SimpleNamespace(all=lambda:[SimpleNamespace(is_visible=lambda:True)])
            self.assertFalse(browser.is_logged_in())

class DesktopFocusTests(unittest.TestCase):
    def test_current_platform_verification_is_not_reloaded(self):
        from types import SimpleNamespace
        from douyin_web.browser import DouyinBrowser
        browser=DouyinBrowser(None);calls=[]
        browser.page=SimpleNamespace(url='https://www.douyin.com/?login=1',
            goto=lambda *a,**kw:calls.append('goto'),bring_to_front=lambda:calls.append('focus'))
        browser.show_desktop(lambda:calls.append('guard'))
        self.assertEqual(calls,['guard','focus'])
        browser.page.url='about:blank';calls.clear();browser.show_desktop(lambda:calls.append('guard'))
        self.assertEqual(calls,['guard','goto','guard','focus'])
class SearchRecordTests(unittest.TestCase):
    def test_search_keeps_endpoint_even_when_body_contains_aweme_list(self):
        from types import SimpleNamespace
        callbacks={}
        page=SimpleNamespace(on=lambda event,cb:callbacks.update({event:cb}),remove_listener=lambda *args:None,wait_for_timeout=lambda ms:None)
        transport=Transport(SimpleNamespace(page=page));transport.check=lambda:None
        body={'status_code':0,'aweme_list':[],'data':[{'aweme_info':{'aweme_id':'observed'}}],'has_more':False}
        transport.goto=lambda url:callbacks['response'](SimpleNamespace(url='https://www.douyin.com/aweme/v1/web/search/item/?keyword=coffee&sort_type=0',json=lambda:body))
        rows=[];transport.search('coffee',max_items=5,max_pages=1,on_page=rows.append)
        self.assertEqual(rows[0]['endpoint'],'aweme_v1_web_search_item')
        self.assertIs(rows[0]['body'],body)
class RequestEvidenceTests(unittest.TestCase):
    def test_comment_records_keep_request_cursor_not_next_cursor(self):
        t=Fake([{'comments':[{'cid':'c1','aweme_id':'post'}],'cursor':12,'has_more':True},{'comments':[{'cid':'c2','aweme_id':'post'}],'cursor':30,'has_more':False}]);rows=[]
        t.pages('post.comments',{'post_id':'post'},max_items=100,max_pages=2,cursor=7,on_page=rows.append)
        self.assertEqual([p['request_params'] for p in rows],[{'aweme_id':'post','cursor':7},{'aweme_id':'post','cursor':12}])
        self.assertEqual([p['cursor'] for p in rows],[12,30])
    def test_worker_records_preserve_only_safe_request_metadata(self):
        import worker
        from unittest.mock import patch
        value={'body':{'comments':[]},'request_params':{'aweme_id':'post','cursor':0,'msToken':'private','signature':'private'}}
        with patch.object(worker,'emit') as emit,patch.object(worker,'answer',return_value={'action':'continue'}):
            worker.page(value)
        self.assertEqual(emit.call_args.args[0]['data']['records'][0]['request_params'],{'aweme_id':'post','cursor':0})
class CoCreatedEvidenceTests(unittest.TestCase):
    def test_profile_owner_and_co_created_author_remain_distinct(self):
        t=Fake([{'user':{'sec_uid':'owner'}},{'aweme_list':[{'aweme_id':'co-created','author':{'sec_uid':'other-author'}}],'max_cursor':123,'has_more':False}]);rows=[]
        t.pages('profile.posts',{'user_id':'owner'},max_items=5,max_pages=1,include_profile=True,on_page=rows.append)
        self.assertEqual(rows[1]['request_params'],{'sec_user_id':'owner','max_cursor':0})
        self.assertEqual(rows[1]['items'][0]['author']['sec_uid'],'other-author')
class SearchWaitTests(unittest.TestCase):
    def test_delayed_search_response_is_observed_without_another_page_action(self):
        from types import SimpleNamespace
        callbacks={};waits=[];guards=[]
        def wait(ms):
            waits.append(ms)
            if len(waits)==6:callbacks['response'](SimpleNamespace(url='https://www.douyin.com/aweme/v1/web/search/item/?keyword=coffee',json=lambda:{'data':[{'aweme_info':{'aweme_id':'late'}}],'has_more':False}))
        page=SimpleNamespace(on=lambda event,cb:callbacks.update({event:cb}),remove_listener=lambda *args:None,wait_for_timeout=wait)
        transport=Transport(SimpleNamespace(page=page),before_action=lambda:guards.append(True));transport.check=lambda:None;transport.goto=lambda url:None
        rows=[];transport.search('coffee',max_items=5,max_pages=1,on_page=rows.append)
        self.assertEqual(rows[0]['items'][0]['aweme_id'],'late');self.assertEqual(len(waits),6);self.assertEqual(len(guards),6)
    def test_missing_response_has_bounded_wait_and_removes_listener(self):
        from types import SimpleNamespace
        waits=[];removed=[]
        page=SimpleNamespace(on=lambda *args:None,remove_listener=lambda *args:removed.append(args),wait_for_timeout=waits.append)
        transport=Transport(SimpleNamespace(page=page));transport.check=lambda:None;transport.goto=lambda url:None
        with self.assertRaisesRegex(ReadError,'SEARCH_RESPONSE_UNAVAILABLE'):transport.search('coffee',max_items=5,max_pages=1)
        self.assertEqual(sum(waits),10000);self.assertEqual(len(removed),1)
