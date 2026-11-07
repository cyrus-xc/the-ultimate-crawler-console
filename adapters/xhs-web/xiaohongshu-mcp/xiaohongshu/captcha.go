package xiaohongshu

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/go-rod/rod"
	"github.com/sirupsen/logrus"
)

// The platform sometimes pops an in-page verification overlay whose class is
// prefixed “captcha-modal-“. It is not a terminal restriction: the person can
// clear it, or it disappears on its own. While it is up the page state never
// advances, so a read that keeps polling would burn its whole budget and time
// out (the "page is not moving" stall). The platform also renders the overlay
// almost instantly, leaving no window to click through it, so we do not try to
// click it either — we simply wait for it to go away before doing more work.
const (
	captchaModalSelector = `[class*="captcha-modal-"], [class~="captcha-modal"]`
	captchaWaitTimeout   = 60 * time.Second
	captchaPollInterval  = 500 * time.Millisecond
)

// rateLimitPhrases 是反爬/限流弹窗常见文案。这些弹窗 class 常常也带 captcha
// 字样，但文案是“操作太过频繁，请稍后重试”之类。出现后不立即终止读取，而是
// 等 60 秒让弹窗自行消失；若仍存在，则按 CRAWLER_RATE_LIMITED 交给上层做
// cooldown / 重试 / 登录恢复。
var rateLimitPhrases = []string{
	"操作太过频繁",
	"操作过于频繁",
	"访问太过频繁",
	"访问过于频繁",
	"操作频繁",
	"访问频繁",
	"请稍后重试",
	"请稍后再试",
}

// restrictionOverlayPresent reports whether a *visible* restriction overlay
// (captcha modal or rate-limit modal) is on screen. A hidden template node with
// the same class must not stall a read, so the bounding box and computed style
// are checked too. Text phrases are checked as a fallback when the class selector
// does not match the platform's newer anti-bot markup.
func restrictionOverlayPresent(page *rod.Page) bool {
	return restrictionOverlayMatch(page) != ""
}

// restrictionOverlayMatch names what matched ("selector <class>" or
// "phrase <phrase> in <class>"), or "" when nothing is visible. Only the
// element's class and the fixed phrase are reported, never page text.
func restrictionOverlayMatch(page *rod.Page) string {
	res, err := page.Eval(`(sel, phrases) => {
		const isVisible = el => {
			const r = el.getBoundingClientRect();
			const s = getComputedStyle(el);
			return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
		};
		const cls = el => String(el.className || el.tagName).slice(0, 80);
		// 1. captcha-modal-* 类选择器
		for (const el of document.querySelectorAll(sel)) {
			if (!isVisible(el)) continue;
			const text = el.innerText || '';
			for (const p of phrases) { if (text.includes(p)) return 'phrase ' + p + ' in ' + cls(el); }
			if (['请完成验证', '请完成下方验证', '拖动滑块', '完成安全验证'].some(p => text.includes(p))) return 'verification ' + cls(el);
			return 'selector ' + cls(el);
		}
		// 2. 兜底：任何可见的 mask/modal/dialog 容器里出现限流文案
		const candidates = document.querySelectorAll('[class*="modal"], [class*="dialog"], [class*="mask"], [class*="overlay"], [class*="captcha"], [class*="verify"]');
		for (const el of candidates) {
			if (!isVisible(el)) continue;
			const text = (el.innerText || '').trim();
			for (const p of phrases) {
				if (text.includes(p)) return 'phrase ' + p + ' in ' + cls(el);
			}
			if (['请完成验证', '请完成下方验证', '拖动滑块', '完成安全验证'].some(p => text.includes(p))) return 'verification ' + cls(el);
		}
		return '';
	}`, captchaModalSelector, rateLimitPhrases)
	if err != nil {
		return ""
	}
	return res.Value.Str()
}

// waitForCaptchaUntil polls “present“ until it clears, “timeout“ elapses, or
// the context is cancelled. It returns true when the modal is gone (including
// "it was never there"). Kept browser-free so the timing logic is unit-testable.
func waitForCaptchaUntil(ctx context.Context, present func() bool, timeout, poll time.Duration) bool {
	if !present() {
		return true
	}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return false
		case <-time.After(poll):
		}
		if !present() {
			return true
		}
	}
	return !present()
}

var errRestrictionStayed = errors.New("restriction overlay stayed")

// restrictionWait waits for a shown overlay to clear. An overlay still up when
// the wait or the read's own deadline ends is errRestrictionStayed: the read
// budget (50s) is shorter than captchaWaitTimeout, and reporting that as a
// timeout made the collector stop instead of cooling down. Only a cancelled
// read (a person stopping it) keeps its context error.
func restrictionWait(ctx context.Context, present func() bool, timeout, poll time.Duration) error {
	if waitForCaptchaUntil(ctx, present, timeout, poll) {
		return nil
	}
	if errors.Is(ctx.Err(), context.Canceled) {
		return ctx.Err()
	}
	return errRestrictionStayed
}

// WaitForRestrictionOverlay blocks while a restriction overlay is visible, up
// to captchaWaitTimeout (or the caller's own deadline, whichever is sooner).
// It returns nil if the overlay clears on its own. If the overlay is still
// visible after the wait, explicit verification demands keep their own code;
// both verification and rate limiting use the existing cooldown policy.
func WaitForRestrictionOverlay(ctx context.Context, page *rod.Page) error {
	match := restrictionOverlayMatch(page.Context(ctx))
	if match == "" {
		return nil
	}
	logrus.Infof("[captcha] restriction overlay shown match=%q", match)
	start := time.Now()
	present := func() bool { return restrictionOverlayPresent(page.Context(ctx)) }
	err := restrictionWait(ctx, present, captchaWaitTimeout, captchaPollInterval)
	if err == nil {
		logrus.Infof("[captcha] restriction overlay cleared after %.1fs", time.Since(start).Seconds())
		return nil
	}
	if !errors.Is(err, errRestrictionStayed) {
		return err
	}
	code := "CRAWLER_RATE_LIMITED"
	if strings.HasPrefix(match, "verification ") {
		code = "CRAWLER_VERIFICATION_REQUIRED"
	}
	logrus.Infof("[captcha] restriction stayed %.1fs code=%s match=%q", time.Since(start).Seconds(), code, match)
	captureAlertPage(page, code)
	return &AccessError{Code: code, Diagnostic: restrictionDiagnostic(ctx, page)}
}

// restrictionDiagnostic captures a minimal allowlisted snapshot of the current
// page for the rate-limit error. It never includes raw body text, URLs with
// tokens, cookies or headers. The read's own context may already be over, so
// the snapshot gets its own one-second bound.
func restrictionDiagnostic(ctx context.Context, page *rod.Page) AccessDiagnostic {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Second)
	defer cancel()
	path := "/unknown"
	if u, err := page.Context(ctx).Eval(`() => location.pathname`); err == nil {
		path = DiagnosticPath(u.Value.Str())
	}
	return AccessDiagnostic{
		ObservedAt:         time.Now().UTC().Format(time.RFC3339),
		Path:               path,
		RestrictionSurface: true,
	}
}
