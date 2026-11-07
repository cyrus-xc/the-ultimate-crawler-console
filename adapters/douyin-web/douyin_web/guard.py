"""Anti-bot wall detection. The collector waits for human captcha verification;
the detector never tries to solve a challenge.

The selectors are *candidates* gathered from public crawler sources and must be
confirmed against what the smoke run actually sees; every hit is recorded with
the selector that fired so the report can say which ones are real.
"""

from __future__ import annotations

from urllib.parse import urlsplit

from typing import TYPE_CHECKING
if TYPE_CHECKING:
    from playwright.sync_api import Page

from .browser import BLOCK_URL_PATTERN

CAPTCHA_SELECTORS = (
    "#captcha_container",
    "#captcha-verify-image",
    ".captcha_verify_container",
    "iframe[src*='verifycenter']",
    "iframe[src*='captcha']",
)
LOGIN_WALL_SELECTORS = (
    "#login-panel-new",
    "[id^='login-full-panel']",
)


class Blocked(RuntimeError):
    def __init__(self, kind: str, detail: str):
        super().__init__(f"{kind}: {detail}")
        self.kind = kind
        self.detail = detail


def _frame_shown(frame) -> bool:
    """Every Douyin page embeds an invisible ``rmc-nocaptcha`` verify iframe
    (observed on all probe pages), so a matching URL alone is not a wall; it
    only counts once the frame is rendered at captcha size."""
    try:
        el = frame.frame_element()
        box = el.bounding_box()
        return bool(box and box["width"] >= 200 and box["height"] >= 150 and el.is_visible())
    except Exception:
        return False


def check(page: Page, *, login_wall_is_block: bool = True) -> dict | None:
    """Return a description of the wall the page is showing, or ``None``."""
    try:
        title = page.title()
    except Exception:
        title = ""
    # Observed 2026-10-04: after ~7 page loads in ~5 min the search page HTML
    # came back as a bare "502 Bad Gateway / kngx" page with no API traffic.
    if "502 Bad Gateway" in title or "Bad Gateway" in title:
        return {"kind": "gateway_502", "detail": title}
    # Observed after a successful phone scan: Douyin requires an additional
    # SMS identity check. This is neither a logged-in session nor a QR failure.
    try:
        heading = page.get_by_text("身份验证", exact=True).first.is_visible()
        sms = any(page.get_by_text(label, exact=True).first.is_visible()
                  for label in ("接收短信验证码", "发送短信验证"))
        if heading and sms:
            return {"kind": "identity_verification", "detail": "sms_identity_verification"}
    except Exception:
        pass
    for frame in page.frames:
        if BLOCK_URL_PATTERN.search(frame.url or "") and _frame_shown(frame):
            url = urlsplit(frame.url)
            return {"kind": "captcha", "detail": f"frame {url.scheme}://{url.hostname}{url.path}"}
    for sel in CAPTCHA_SELECTORS:
        try:
            if page.locator(sel).first.is_visible(timeout=200):
                return {"kind": "captcha", "detail": sel}
        except Exception:
            continue
    if login_wall_is_block:
        for sel in LOGIN_WALL_SELECTORS:
            try:
                if page.locator(sel).first.is_visible(timeout=200):
                    return {"kind": "login_wall", "detail": sel}
            except Exception:
                continue
    return None


def raise_if_blocked(page: Page, **kw) -> None:
    hit = check(page, **kw)
    if hit:
        raise Blocked(hit["kind"], hit["detail"])
