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
        t=OfflineTransport([{'aweme_list':[{'aweme_id':'1','author':{'sec_uid':'other'}}],'has_more':False}])
        with self.assertRaisesRegex(ReadError,'PROFILE_IDENTITY_MISMATCH'):t.pages('profile.posts',{'user_id':'u'},max_items=10,max_pages=1)
    def test_stalled_cursor_does_not_loop_or_claim_end(self):
        t=OfflineTransport([{'comments':[],'cursor':0,'has_more':True}])
        result=t.pages('post.comments',{'post_id':'p'},max_items=50,max_pages=3)
        self.assertEqual(result['coverage']['stop_reason'],'cursor_stalled');self.assertFalse(result['coverage']['end_observed'])
if __name__=='__main__':unittest.main()
