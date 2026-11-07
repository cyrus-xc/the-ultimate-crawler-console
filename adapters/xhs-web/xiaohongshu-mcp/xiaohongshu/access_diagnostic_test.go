package xiaohongshu

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/launcher"
)

func TestAccessDiagnosticPrivacyAndUnknownState(t *testing.T) {
	d := accessDiagnostic("https://www.xiaohongshu.com/website-login/error?code=300012&error_code=SECRET&xsec_token=SECRET#SECRET", "安全限制", "访问频繁，请稍后再试 cookie=SECRET https://secret.invalid/SECRET", "complete")
	b, _ := json.Marshal(d)
	if strings.Contains(string(b), "SECRET") || strings.Contains(string(b), "https:") {
		t.Fatal(string(b))
	}
	if d.ServerCodes["code"] != "300012" || d.Scope != "unknown" || len(d.Notices) == 0 {
		t.Fatal(d)
	}
	empty := accessDiagnostic("https://www.xiaohongshu.com/website-login/error", "安全限制", "", "loading")
	if empty.BodyPresent || empty.PageReadyState != "loading" || len(empty.Notices) != 0 {
		t.Fatal(empty)
	}
	post := accessDiagnostic("https://www.xiaohongshu.com/explore/111111111111111111111111", "ordinary post", "账号异常 unrelated prose SECRET", "complete")
	if len(post.Notices) != 0 || post.RestrictionSurface {
		t.Fatal(post)
	}
	if DiagnosticPath("https://example.test/private/SECRET?token=SECRET") != "/other" {
		t.Fatal("unrecognized path exposed")
	}
}

// Opt-in localhost fixture. No saved login, cookies or XHS connection is used.
func TestAccessDiagnosticLocalBrowser(t *testing.T) {
	bin := os.Getenv("XHS_DIAGNOSTIC_TEST_BROWSER")
	if bin == "" {
		t.Skip("set XHS_DIAGNOSTIC_TEST_BROWSER to run localhost fixture")
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`<title>安全限制</title><body><script>setTimeout(()=>document.body.textContent='访问频繁，请稍后再试 cookie=SECRET',400)</script></body>`))
	}))
	defer srv.Close()
	l := launcher.New().Bin(bin).Headless(true).Leakless(false).Set("no-proxy-server").Set("disable-background-networking")
	b := rod.New().ControlURL(l.MustLaunch()).MustConnect()
	defer l.Cleanup()
	defer b.MustClose()
	p := b.MustPage(srv.URL + "/website-login/error?code=300012&xsec_token=SECRET").MustWaitLoad()
	err := checkAccess(p)
	var access *AccessError
	if !errors.As(err, &access) || access.Code != "CRAWLER_RATE_LIMITED" {
		t.Fatalf("unexpected diagnostic: %v", err)
	}
	raw, _ := json.Marshal(access.Diagnostic)
	if strings.Contains(string(raw), "SECRET") || access.Diagnostic.ServerCodes["code"] != "300012" {
		t.Fatal(string(raw))
	}
}
