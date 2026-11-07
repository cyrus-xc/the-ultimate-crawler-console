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
