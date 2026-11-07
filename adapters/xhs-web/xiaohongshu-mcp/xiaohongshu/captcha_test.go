package xiaohongshu

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/launcher"
)

// The captcha gate must not stall a read when no modal is present, must return
// as soon as the modal clears, and must be bounded by both its own timeout and
// the caller's context.
func TestWaitForCaptchaUntil(t *testing.T) {
	t.Run("returns immediately when no modal is present", func(t *testing.T) {
		calls := 0
		present := func() bool { calls++; return false }
		if !waitForCaptchaUntil(context.Background(), present, time.Second, time.Millisecond) {
			t.Fatal("expected true when nothing is blocking")
		}
		if calls != 1 {
			t.Fatalf("expected a single probe, got %d", calls)
		}
	})

	t.Run("returns once the modal clears", func(t *testing.T) {
		remaining := 3 // probes before it clears
		present := func() bool {
			if remaining <= 0 {
				return false
			}
			remaining--
			return true
		}
		start := time.Now()
		if !waitForCaptchaUntil(context.Background(), present, time.Second, time.Millisecond) {
			t.Fatal("expected true once the modal cleared")
		}
		if elapsed := time.Since(start); elapsed > 500*time.Millisecond {
			t.Fatalf("took too long: %v", elapsed)
		}
	})

	t.Run("gives up after its own timeout while still blocked", func(t *testing.T) {
		present := func() bool { return true }
		if waitForCaptchaUntil(context.Background(), present, 20*time.Millisecond, time.Millisecond) {
			t.Fatal("expected false when the modal never cleared")
		}
	})

	t.Run("stops when the caller context is cancelled", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		go func() { time.Sleep(10 * time.Millisecond); cancel() }()
		present := func() bool { return true }
		start := time.Now()
		if waitForCaptchaUntil(ctx, present, time.Minute, time.Millisecond) {
			t.Fatal("expected false on cancellation")
		}
		if elapsed := time.Since(start); elapsed > 500*time.Millisecond {
			t.Fatalf("did not honour cancellation promptly: %v", elapsed)
		}
	})

	// HPC 2026-11-06: the read budget (50s) ends before the 60s overlay wait, so
	// three overlay-blocked reads surfaced as CRAWLER_TIMEOUT and the run stopped
	// instead of cooling down on CRAWLER_RATE_LIMITED.
	t.Run("an overlay that outlasts the read budget is a rate limit, not a timeout", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
		defer cancel()
		err := restrictionWait(ctx, func() bool { return true }, time.Minute, time.Millisecond)
		if !errors.Is(err, errRestrictionStayed) {
			t.Fatalf("expected errRestrictionStayed, got %v", err)
		}
	})

	t.Run("a cancelled read stays cancelled", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		go func() { time.Sleep(10 * time.Millisecond); cancel() }()
		err := restrictionWait(ctx, func() bool { return true }, time.Minute, time.Millisecond)
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("expected context.Canceled, got %v", err)
		}
	})

	t.Run("an overlay that clears lets the read continue", func(t *testing.T) {
		probes := 0
		err := restrictionWait(context.Background(), func() bool { probes++; return probes < 3 }, time.Second, time.Millisecond)
		if err != nil {
			t.Fatalf("expected nil once the overlay cleared, got %v", err)
		}
	})

	t.Run("captcha wait budget stays at 60s", func(t *testing.T) {
		if captchaWaitTimeout != 60*time.Second {
			t.Fatalf("expected a 60s wait, got %v", captchaWaitTimeout)
		}
	})
}

// Opt-in localhost fixture: a rate-limit modal that stays up past the read's
// own deadline must come back as CRAWLER_RATE_LIMITED, naming what matched;
// a hidden template node must not block at all.
func TestRestrictionOverlayLocalBrowser(t *testing.T) {
	bin := os.Getenv("XHS_DIAGNOSTIC_TEST_BROWSER")
	if bin == "" {
		t.Skip("set XHS_DIAGNOSTIC_TEST_BROWSER to run localhost fixture")
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		body := `<div class="toast-mask" style="display:none">操作太过频繁，请稍后再试</div>`
		if r.URL.Path == "/shown" {
			body = `<div class="toast-mask" style="width:200px;height:80px">操作太过频繁，请稍后再试</div>`
		}
		if r.URL.Path == "/verification" {
			body = `<div class="captcha-modal-box" style="width:200px;height:80px">请完成下方验证</div>`
		}
		_, _ = w.Write([]byte(`<body>` + body + `</body>`))
	}))
	defer srv.Close()
	l := launcher.New().Bin(bin).Headless(true).Leakless(false).Set("no-proxy-server").Set("disable-background-networking")
	b := rod.New().ControlURL(l.MustLaunch()).MustConnect()
	defer l.Cleanup()
	defer b.MustClose()

	hidden := b.MustPage(srv.URL + "/hidden").MustWaitLoad()
	start := time.Now()
	if err := WaitForRestrictionOverlay(context.Background(), hidden); err != nil || time.Since(start) > 2*time.Second {
		t.Fatalf("hidden overlay blocked the read: %v after %s", err, time.Since(start))
	}

	shown := b.MustPage(srv.URL + "/shown").MustWaitLoad()
	if m := restrictionOverlayMatch(shown); !strings.Contains(m, "toast-mask") || !strings.Contains(m, "操作太过频繁") {
		t.Fatalf("match did not name the overlay: %q", m)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	err := WaitForRestrictionOverlay(ctx, shown.Context(ctx))
	var access *AccessError
	if !errors.As(err, &access) || access.Code != "CRAWLER_RATE_LIMITED" || !access.Diagnostic.RestrictionSurface {
		t.Fatalf("expected CRAWLER_RATE_LIMITED at the read deadline, got %v", err)
	}
	verification := b.MustPage(srv.URL + "/verification").MustWaitLoad()
	vctx, vcancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer vcancel()
	err = WaitForRestrictionOverlay(vctx, verification.Context(vctx))
	if !errors.As(err, &access) || access.Code != "CRAWLER_VERIFICATION_REQUIRED" {
		t.Fatalf("explicit CAPTCHA must not be reported as a rate limit: %v", err)
	}
}
