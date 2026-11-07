"""Browser session for the Douyin PoC: one persistent Chromium profile plus a
response recorder.

Collection works by *observing* the JSON the real Douyin web app fetches for
itself (``page.on("response")``). We never build or sign API requests, so
``a_bogus`` / ``msToken`` rotation is the page's problem, not ours.

The Chromium binary is the one the XHS crawler already ships in
``runtime/browser/``; the login profile lives in ``runtime/douyin/profile``
so it never mixes with the XHS session.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, TYPE_CHECKING
from urllib.parse import urlparse

if TYPE_CHECKING:
    from playwright.sync_api import BrowserContext, Page, Response

REPO_ROOT = Path(__file__).resolve().parents[3]
PROFILE_DIR = Path(os.environ.get("DOUYIN_BROWSER_PROFILE", REPO_ROOT / "runtime/douyin/profile"))
# The XHS crawler's built-in Chromium: one version file for Go and Python, the
# same cache directory (core.collect.runtime_env), one binary name per OS. Until
# 2026-10-05 this was a fixed Windows path, so every Douyin run failed on a Mac.
BROWSER_VERSION_FILE = REPO_ROOT / "adapters/xhs-web/xiaohongshu-mcp/browser/browser_version.txt"
BINARY_NAMES = {"win32": "chrome.exe", "darwin": "Chromium", "linux": "chrome"}
_resolved: dict[str, tuple[Path | None, str]] = {}


def builtin_chrome() -> Path | None:
    """The built-in Chromium for this OS if it has been downloaded (the XHS
    crawler downloads it on first use; Apple-chip Macs, Windows, Linux x64)."""
    from .runtime import runtime_paths

    name = BINARY_NAMES.get(sys.platform)
    root = runtime_paths()["browser"] / BROWSER_VERSION_FILE.read_text(encoding="utf-8").strip()
    if not name or not root.is_dir():
        return None
    return next((p for p in root.rglob(name) if p.is_file()), None)


def chrome_executable() -> tuple[Path | None, str]:
    """(path, source). source "playwright" means Playwright's own Chromium:
    launch without executable_path (needs ``playwright install chromium``)."""
    configured = os.environ.get("CRAWLER_BROWSER_EXECUTABLE")
    if configured:
        path = Path(configured)
        if not path.is_file():
            raise RuntimeError("BROWSER_EXECUTABLE_MISSING")
        return path, "configured"
    if "result" not in _resolved:
        found = builtin_chrome()
        _resolved["result"] = (found, "built-in") if found else (None, "playwright")
    return _resolved["result"]


def playwright_chromium() -> Path | None:
    """Playwright's bundled Chromium, if installed."""
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        path = Path(pw.chromium.executable_path)
    return path if path.exists() else None

# JSON endpoints worth keeping. Everything under these prefixes on a
# douyin.com host is recorded verbatim; the inventory step decides what is
# useful.
RECORD_PATH_PREFIXES = ("/aweme/", "/web/api/", "/webcast/")
# Endpoints about the *logged-in* account (our own profile, IM, settings) are
# never written to disk: they carry the operator's personal data and are of no
# use for KOL analysis.
SKIP_ENDPOINT_PATTERN = re.compile(
    r"user_profile_self|_im_|query_user|social_count|notice_count|user_settings|"
    r"get_user_settings|solution_resource_list|external_notification|emoji|app_installed|"
    r"multicast|page_turn_offline|webcast_(setting|diamond|ip_wiki)|aweme_favorite"
)
# Signals that the session hit an anti-bot wall. Matched against frame/request
# URLs; DOM checks live in ``guard.py``.
BLOCK_URL_PATTERN = re.compile(r"verifycenter|captcha|/verify|rmc\.bytedance\.com", re.I)


def endpoint_name(url: str) -> str:
    """``/aweme/v1/web/aweme/post/`` -> ``aweme_v1_web_aweme_post``."""
    path = urlparse(url).path.strip("/")
    return re.sub(r"[^a-zA-Z0-9]+", "_", path)[:80] or "root"


@dataclass
class Recorder:
    """Writes every matching JSON response to ``out_dir`` as one file each."""

    out_dir: Path
    step: str = ""
    seq: int = 0
    index: list[dict] = field(default_factory=list)
    block_events: list[dict] = field(default_factory=list)
    listeners: list[Callable[[str, dict], None]] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.out_dir.mkdir(parents=True, exist_ok=True)

    def on_request(self, request) -> None:
        # The verify SDK (scripts, the hidden rmc-nocaptcha iframe) is preloaded
        # on every page; only API calls to the verify service are worth noting.
        if request.resource_type in ("xhr", "fetch") and BLOCK_URL_PATTERN.search(request.url):
            self.block_events.append({"at": time.time(), "kind": "request", "url": request.url})

    def on_response(self, response: Response) -> None:
        url = response.url
        host = urlparse(url).hostname or ""
        if host != "douyin.com" and not host.endswith(".douyin.com"):
            return
        if not urlparse(url).path.startswith(RECORD_PATH_PREFIXES):
            return
        name = endpoint_name(url)
        if SKIP_ENDPOINT_PATTERN.search(name):
            return
        try:
            body = response.json()
        except Exception:  # non-JSON (protobuf, empty, aborted)
            return
        self.seq += 1
        path = self.out_dir / f"{self.seq:04d}_{name}.json"
        record = {
            "seq": self.seq,
            "step": self.step,
            "captured_at": time.time(),
            "url": url,
            "status": response.status,
            "endpoint": name,
            "body": body,
        }
        path.write_text(json.dumps(record, ensure_ascii=False, indent=1), encoding="utf-8")
        self.index.append({k: record[k] for k in ("seq", "step", "endpoint", "status", "url")} | {"file": path.name})
        for listener in self.listeners:
            listener(name, body)

    def write_index(self) -> None:
        (self.out_dir / "_index.json").write_text(
            json.dumps({"responses": self.index, "block_events": self.block_events}, ensure_ascii=False, indent=1),
            encoding="utf-8",
        )


class DouyinBrowser:
    """Context manager around a persistent, headful Chromium profile."""

    def __init__(self, recorder: Recorder | None, profile_dir: Path | None = PROFILE_DIR, headless: bool = False):
        self.recorder = recorder
        self.profile_dir = profile_dir
        self.headless = headless
        self._pw = None
        self._profile_lease = None
        self.context: BrowserContext | None = None
        self.page: Page | None = None

    def __enter__(self) -> "DouyinBrowser":
        # Every consumer (login, analytics and CampaignWatch) owns the same
        # persistent profile exclusively. The OS releases this lease on crash.
        if self.profile_dir is not None:
            from .runtime import lease
            profile = self.profile_dir.resolve()
            self._profile_lease = lease(profile.with_name(profile.name + '.worker.lock'), timeout=0)
            try:
                self._profile_lease.__enter__()
            except TimeoutError as exc:
                self._profile_lease = None
                from .runtime import BrowserError
                raise BrowserError('DOUYIN_PROFILE_BUSY') from exc
        try:
            return self._open()
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def _open(self) -> "DouyinBrowser":
        from playwright.sync_api import sync_playwright
        from .runtime import hidden_desktop_env
        desktop = hidden_desktop_env()
        self._pw = sync_playwright().start()
        executable, _source = chrome_executable()
        launch = dict(
            headless=self.headless,
            env={**os.environ, **desktop},
            viewport={"width": 1366, "height": 860},
            locale="zh-CN",
            timezone_id="Asia/Shanghai",
            args=["--disable-blink-features=AutomationControlled", "--ozone-platform=wayland", "--class=ultimate-crawler-douyin"],
        )
        if executable is not None:
            launch["executable_path"] = str(executable)
        if self.profile_dir is None:
            # Anonymous probe: throwaway context, nothing persisted.
            browser = self._pw.chromium.launch(**{k: v for k, v in launch.items() if k in ("executable_path", "headless", "args", "env")})
            self.context = browser.new_context(**{k: v for k, v in launch.items() if k in ("viewport", "locale", "timezone_id")})
        else:
            self.profile_dir.mkdir(parents=True, exist_ok=True)
            self.context = self._pw.chromium.launch_persistent_context(str(self.profile_dir), **launch)
        self.page = self.context.pages[0] if self.context.pages else self.context.new_page()
        if self.recorder is not None:
            self.context.on("response", self.recorder.on_response)
            self.context.on("request", self.recorder.on_request)
        return self

    def __exit__(self, *exc) -> None:
        try:
            if self.recorder is not None:
                self.recorder.write_index()
        finally:
            try:
                if self.context is not None:
                    self.context.close()
            finally:
                try:
                    if self._pw is not None:
                        self._pw.stop()
                finally:
                    if self._profile_lease is not None:
                        self._profile_lease.__exit__(*exc)
                        self._profile_lease = None
                    self.context = None
                    self._pw = None

    def cookies(self) -> dict[str, str]:
        return {c["name"]: c["value"] for c in self.context.cookies("https://www.douyin.com")}

    def login_state(self) -> dict:
        """Every login signal we know of, reported side by side so the smoke
        run can tell which one Douyin actually sets."""
        cookies = self.cookies()
        try:
            has_user_login = self.page.evaluate("() => window.localStorage.getItem('HasUserLogin')")
        except Exception:
            has_user_login = None
        return {
            "cookie_LOGIN_STATUS": cookies.get("LOGIN_STATUS"),
            "cookie_sessionid_present": bool(cookies.get("sessionid") or cookies.get("sessionid_ss")),
            "localStorage_HasUserLogin": has_user_login,
        }

    def is_logged_in(self) -> bool:
        from . import guard
        if urlparse(self.page.url).hostname not in ('www.douyin.com','douyin.com'):
            return False
        if self.page.evaluate("() => document.readyState") not in ('interactive','complete'):
            return False
        if any(button.is_visible() for button in self.page.get_by_text('登录',exact=True).all()):
            return False
        state = self.login_state()
        hinted = (state["cookie_LOGIN_STATUS"] == "1" or state["cookie_sessionid_present"]
                  or state["localStorage_HasUserLogin"] == "1")
        # Saved cookies/local storage survive logout and visible login walls.
        return bool(hinted) and guard.check(self.page, login_wall_is_block=True) is None
