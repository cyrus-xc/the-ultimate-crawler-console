import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('login_diagnostics',Path(__file__).resolve().parents[1]/'adapters/douyin-web/login_diagnostics.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class LoginDiagnosticTests(unittest.TestCase):
    def test_credentials_never_survive_projection(self):
        endpoint=module.endpoint('https://sso.douyin.com/passport/web/check_qrconnect/?token=secret')
        self.assertEqual(endpoint,{'host':'sso.douyin.com','path':'/passport/web/check_qrconnect/'})
        self.assertEqual(module.codes({'error_code':0,'token':'secret','data':{'status':'confirmed','code':'secret','redirect_url':'secret'}}),{'error_code':0,'data.status':'confirmed'})
        self.assertEqual(module.endpoint('https://sso.douyin.com/login/secret123')['path'],'[redacted_path]')
    def test_unrelated_response_and_non_scalar_codes_excluded(self):
        self.assertIsNone(module.endpoint('https://www.douyin.com/aweme/v1/web/feed/'))
        self.assertIsNone(module.endpoint('https://evil.example/passport/login'))
        self.assertEqual(module.codes({'code':{'token':'secret'},'status':True}),{})

class IdentityWallTests(unittest.TestCase):
    def page(self, labels):
        from types import SimpleNamespace
        return SimpleNamespace(title=lambda:'抖音', frames=[],
            locator=lambda selector:SimpleNamespace(first=SimpleNamespace(is_visible=lambda **kw:False)),
            get_by_text=lambda text,**kw:SimpleNamespace(first=SimpleNamespace(is_visible=lambda:text in labels)))

    def test_actual_sms_identity_wall_is_blocking_even_without_login_wall_check(self):
        import sys
        sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'adapters/douyin-web'))
        from douyin_web import guard
        self.assertEqual(guard.check(self.page({'身份验证','接收短信验证码'}),login_wall_is_block=False),
                         {'kind':'identity_verification','detail':'sms_identity_verification'})
        self.assertIsNone(guard.check(self.page({'身份验证'}),login_wall_is_block=False))
        self.assertIsNone(guard.check(self.page({'验证码登录'}),login_wall_is_block=False))

    def test_wall_diagnostic_uses_only_fixed_safe_message(self):
        import tempfile,json
        with tempfile.TemporaryDirectory() as root:
            diagnostic=module.LoginDiagnostics(root);diagnostic.start();diagnostic.wall('identity_verification')
            value=json.loads(diagnostic.file.read_text())['events'][0]
            self.assertEqual(value['ui_status'],'identity_verification')
            self.assertEqual(value['message'],'Complete the verification shown by Douyin.')
            diagnostic.wall('secret');self.assertEqual(len(diagnostic.events),1)
