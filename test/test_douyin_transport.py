import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'adapters/douyin-web'))
from douyin_web.transport import Transport,ReadError
class OfflineTransport(Transport):
    def __init__(self,bodies):self.bodies=iter(bodies);self.calls=[]
    def goto(self,url):self.url=url
    def api(self,path,params):self.calls.append((path,params));return next(self.bodies)
class DouyinTests(unittest.TestCase):
    def test_profile_pages_keep_whole_loaded_page_and_cursor(self):
        t=OfflineTransport([{'aweme_list':[{'aweme_id':str(i),'author':{'sec_uid':'u'}} for i in range(3)],'max_cursor':18,'has_more':True}])
        result=t.pages('profile.posts',{'user_id':'u'},max_items=2,max_pages=3)
        self.assertEqual(len(result['pages'][0]['items']),3)
        self.assertEqual(result['coverage']['stop_reason'],'item_limit')
    def test_comment_cursor_advances_and_reports_observed_end(self):
        t=OfflineTransport([{'comments':[{'cid':'1'}],'cursor':20,'has_more':True},{'comments':[{'cid':'2'}],'cursor':40,'has_more':False}])
        pages=[];result=t.pages('post.comments',{'post_id':'p'},max_items=50,max_pages=3,on_page=pages.append)
        self.assertEqual(t.calls[1][1]['cursor'],20);self.assertTrue(result['coverage']['end_observed']);self.assertEqual(len(pages),2)
    def test_page_limit_is_not_claimed_as_complete(self):
        t=OfflineTransport([{'comments':[{'cid':'1'}],'cursor':20,'has_more':True}])
        result=t.pages('post.comments',{'post_id':'p'},max_items=50,max_pages=1)
        self.assertEqual(result['coverage']['stop_reason'],'page_limit');self.assertFalse(result['coverage']['end_observed'])
    def test_wrong_profile_rejected(self):
        t=OfflineTransport([{'user':{'sec_uid':'other'}}])
        observed=[]
        with self.assertRaisesRegex(ReadError,'PROFILE_IDENTITY_MISMATCH'):
            t.pages('profile.posts',{'user_id':'u'},max_items=10,max_pages=1,include_profile=True,on_page=observed.append)
        self.assertEqual(observed,[])
        self.assertEqual(len(t.calls),1)
        self.assertEqual(t.calls[0][1]['sec_user_id'],'u')
    def test_co_created_profile_post_preserves_list_owner_and_original_author(self):
        t=OfflineTransport([{'user':{'sec_uid':'u'}},{'aweme_list':[{'aweme_id':'1','author':{'sec_uid':'other'}}],'max_cursor':18,'has_more':False}])
        observed=[]
        t.pages('profile.posts',{'user_id':'u'},max_items=10,max_pages=1,include_profile=True,on_page=observed.append)
        self.assertEqual(observed[0]['items'][0]['sec_uid'],'u')
        self.assertEqual(observed[1]['request_params'],{'sec_user_id':'u','max_cursor':0})
        self.assertEqual(observed[1]['items'][0]['author']['sec_uid'],'other')
    def test_stalled_cursor_does_not_loop_or_claim_end(self):
        t=OfflineTransport([{'comments':[],'cursor':0,'has_more':True}])
        result=t.pages('post.comments',{'post_id':'p'},max_items=50,max_pages=3)
        self.assertEqual(result['coverage']['stop_reason'],'cursor_stalled');self.assertFalse(result['coverage']['end_observed'])
    def test_local_stop_retains_page_and_never_fetches_next_cursor(self):
        t=OfflineTransport([{'comments':[{'cid':'1'}],'cursor':20,'has_more':True}])
        result=t.pages('post.comments',{'post_id':'p'},max_items=50,max_pages=3,on_page=lambda page:'stop')
        self.assertEqual(len(t.calls),1)
        self.assertEqual(result['pages'][0]['cursor'],20)
        self.assertEqual(result['coverage']['stop_reason'],'client_stopped')
        self.assertFalse(result['coverage']['end_observed'])
if __name__=='__main__':unittest.main()
