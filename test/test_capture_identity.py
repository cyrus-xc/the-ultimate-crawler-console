import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'adapters/xhs-phone'))
from capture_cli import verify_app_identity

class IdentityTests(unittest.TestCase):
    def test_transient_identity_failures_differ_from_wrong_package_and_unload(self):
        for message,code in [(None,'APP_IDENTITY_TIMEOUT'),({'type':'send','payload':{'package':None}},'APP_IDENTITY_UNAVAILABLE'),({'type':'error'},'APP_IDENTITY_UNAVAILABLE'),({'type':'send','payload':{'package':'other.app'}},'APP_MAIN_PROCESS_MISMATCH'),({'type':'send','payload':{'package':'com.xingin.xhs'}},None)]:
            with self.subTest(code=code):
                callbacks={};unloaded=[]
                script=SimpleNamespace(on=lambda name,fn:callbacks.update({name:fn}),load=lambda:callbacks['message'](message,None) if message else None,unload=lambda:unloaded.append(True))
                session=SimpleNamespace(create_script=lambda source:script)
                if code:
                    with self.assertRaisesRegex(RuntimeError,code):verify_app_identity(session,'com.xingin.xhs',timeout=.001)
                else:verify_app_identity(session,'com.xingin.xhs',timeout=.001)
                self.assertEqual(unloaded,[True])
