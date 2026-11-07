"""Browser ownership regressions moved from the pipeline to the executor."""
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock, patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'adapters/douyin-web'))

class BrowserLease(unittest.TestCase):

    def test_all_consumers_share_profile_lease_and_release_on_close(self):
        from douyin_web.browser import DouyinBrowser
        with TemporaryDirectory() as folder:
            profile = Path(folder) / 'profile'
            first = DouyinBrowser(None, profile_dir=profile)
            second = DouyinBrowser(None, profile_dir=profile)
            with patch.object(first, '_open', return_value=first), patch.object(second, '_open', return_value=second):
                first.__enter__()
                try:
                    with self.assertRaisesRegex(RuntimeError, 'DOUYIN_PROFILE_BUSY'):
                        second.__enter__()
                    second._open.assert_not_called()
                finally:
                    first.__exit__(None, None, None)
                second.__enter__(); second.__exit__(None, None, None)

    def test_launch_and_close_failures_release_profile(self):
        from douyin_web.browser import DouyinBrowser
        with TemporaryDirectory() as folder:
            profile = Path(folder) / 'profile'
            first = DouyinBrowser(None, profile_dir=profile)
            with patch.object(first, '_open', side_effect=RuntimeError('launch failed')):
                with self.assertRaisesRegex(RuntimeError, 'launch failed'):
                    first.__enter__()
            second = DouyinBrowser(None, profile_dir=profile)
            with patch.object(second, '_open', return_value=second):
                second.__enter__()
                second.context = Mock(); second.context.close.side_effect = RuntimeError('close failed')
                second._pw = Mock(); playwright = second._pw
                with self.assertRaisesRegex(RuntimeError, 'close failed'):
                    second.__exit__(None, None, None)
                playwright.stop.assert_called_once()
                third = DouyinBrowser(None, profile_dir=profile)
                with patch.object(third, '_open', return_value=third):
                    third.__enter__(); third.__exit__(None, None, None)

class BrowserCache(unittest.TestCase):
    def test_builtin_browser_is_resolved_per_os(self):
        from douyin_web import browser, runtime
        for os_name, parts in [('darwin',['Chromium.app','Contents','MacOS','Chromium']),
                               ('win32',['browser','chrome.exe']),('linux',['chrome-linux','chrome'])]:
            with self.subTest(os_name=os_name), TemporaryDirectory() as folder:
                root=Path(folder)
                version=browser.BROWSER_VERSION_FILE.read_text(encoding='utf8').strip()
                binary=root.joinpath(version,*parts);binary.parent.mkdir(parents=True);binary.write_text('')
                browser._resolved.clear()
                try:
                    with patch.object(browser.sys,'platform',os_name), patch.object(runtime,'runtime_paths',return_value={'browser':root}):
                        self.assertEqual(browser.builtin_chrome(),binary)
                        self.assertEqual(browser.chrome_executable(),(binary,'built-in'))
                finally:browser._resolved.clear()
    def test_foreign_os_binary_is_not_used(self):
        from douyin_web import browser, runtime
        with TemporaryDirectory() as folder:
            root=Path(folder);binary=root/browser.BROWSER_VERSION_FILE.read_text().strip()/'browser/chrome.exe'
            binary.parent.mkdir(parents=True);binary.write_text('');browser._resolved.clear()
            try:
                with patch.object(browser.sys,'platform','darwin'),patch.object(runtime,'runtime_paths',return_value={'browser':root}):
                    self.assertEqual(browser.chrome_executable(),(None,'playwright'))
            finally:browser._resolved.clear()
