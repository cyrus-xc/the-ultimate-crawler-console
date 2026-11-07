import unittest,importlib.util,json
from pathlib import Path
from unittest.mock import patch
p=Path(__file__).resolve().parents[1]/'adapters/xhs-web/share_page.py'
spec=importlib.util.spec_from_file_location('share_page',p);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class SharePageTests(unittest.TestCase):
    def fixture(self):
        note={'noteId':'a'*24,'user':{'userId':'b'*24,'nickName':'作者'},'poi':{'poiId':'p','name':'店'},'interactInfo':{'likedCount':'1.2万'},'type':'normal','time':1700000000000,'title':'正文'}
        return 'window.__INITIAL_STATE__='+json.dumps({'noteData':{'data':{'noteData':note}}},ensure_ascii=False)
    def test_preserves_raw_metadata_and_nullable_metrics(self):
        data=m.note_detail_from_page(self.fixture(),'a'*24)
        self.assertEqual(data['liked_count'],12000);self.assertIsNone(data['shared_count']);self.assertEqual(data['poi_name'],'店');self.assertEqual(data['create_time'],1700000000)
        self.assertIsNone(m.note_detail_from_page(self.fixture(),'c'*24))
    def test_metadata_and_detail_have_original_distinct_shapes(self):
        request={'operation':'post.detail','target':{'post_id':'a'*24,'observed_url':'https://www.xiaohongshu.com/explore/'+'a'*24},'params':{'native_request':{'representation':'mobile_metadata'}}}
        with patch.object(m,'fetch_page',return_value=(request['target']['observed_url'],self.fixture())):
            metadata=m.run(request);self.assertEqual(metadata['nickname'],'作者');self.assertNotIn('liked_count',metadata)
            request['params']['native_request']['representation']='mobile_detail';self.assertEqual(m.run(request)['liked_count'],12000)
    def test_bare_id_does_not_construct_access_url_or_read_network(self):
        with patch.object(m,'fetch_page') as fetch:
            self.assertIsNone(m.run({'operation':'post.detail','target':{'post_id':'a'*24}}));fetch.assert_not_called()
    def test_untrusted_host_and_scheme_rejected(self):
        for url in ['file:///etc/passwd','https://127.0.0.1/x','https://xiaohongshu.com:8888/x','https://user:pw@www.xiaohongshu.com/x']:
            with self.assertRaisesRegex(ValueError,'INVALID_OBSERVED_URL'):m.fetch_page(url)
    def test_resolution_retains_observed_url_and_identity(self):
        url='https://www.xiaohongshu.com/explore/'+'a'*24+'?xsec_token=fixture'
        with patch.object(m,'fetch_page',return_value=(url,'')):
            self.assertEqual(m.resolve('https://xhslink.com/fixture'),{'resolved_url':url,'post_id':'a'*24})
