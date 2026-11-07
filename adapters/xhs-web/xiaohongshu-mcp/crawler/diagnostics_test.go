package crawler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/launcher"
	"github.com/go-rod/rod/lib/proto"
	"github.com/xpzouying/xiaohongshu-mcp/xiaohongshu"
)

func TestDiagnosticsRedirectTimingPrivacyAndBound(t *testing.T) {
	trace := newReadTrace()
	trace.requested(&proto.NetworkRequestWillBeSent{RequestID: "document", Type: proto.NetworkResourceTypeDocument,
		WallTime: 1790000000, Request: &proto.NetworkRequest{URL: "https://www.xiaohongshu.com/explore/111111111111111111111111?xsec_token=SECRET"}})
	trace.requested(&proto.NetworkRequestWillBeSent{RequestID: "document", Type: proto.NetworkResourceTypeDocument,
		Request: &proto.NetworkRequest{URL: "https://www.xiaohongshu.com/website-login/error?code=300012&cookie=SECRET"}, RedirectResponse: &proto.NetworkResponse{Status: 302}})
	trace.responded(&proto.NetworkResponseReceived{RequestID: "document", Response: &proto.NetworkResponse{Status: 200}})
	for i := 0; i < 30; i++ {
		trace.requested(&proto.NetworkRequestWillBeSent{RequestID: proto.NetworkRequestID(fmt.Sprint(i)), Type: proto.NetworkResourceTypeDocument, Request: &proto.NetworkRequest{URL: "https://test.invalid/SECRET"}})
	}
	d := trace.finish(nil)
	if d.NetworkRequests != 32 || !d.DocumentsTruncated || len(d.Documents) != 16 || d.Documents[0].HTTPStatus != 302 || d.Documents[1].HTTPStatus != 200 {
		t.Fatal(d)
	}
	if d.Documents[0].RequestedAt != "2026-09-21T14:13:20Z" {
		t.Fatal(d.Documents[0])
	}
	b, _ := json.Marshal(d)
	if strings.Contains(string(b), "SECRET") || strings.Contains(string(b), "xsec_token") {
		t.Fatal(string(b))
	}
}

func TestDiagnosticsSurviveWrappedError(t *testing.T) {
	err := fmt.Errorf("read: %w", &xiaohongshu.AccessError{Code: "CRAWLER_ACCESS_RESTRICTED", Diagnostic: xiaohongshu.AccessDiagnostic{Path: "/website-login/error", Scope: "unknown"}})
	d := newReadTrace().finish(err)
	wrapped := &diagnosticError{cause: err, diagnostic: d}
	if d.Access == nil || ErrorCode(wrapped) != "CRAWLER_ACCESS_RESTRICTED" || ErrorDiagnostics(wrapped) == nil {
		t.Fatal(wrapped)
	}
}

func TestDiagnosticTraceLocalBrowser(t *testing.T) {
	bin := os.Getenv("XHS_DIAGNOSTIC_TEST_BROWSER")
	if bin == "" {
		t.Skip("set XHS_DIAGNOSTIC_TEST_BROWSER for localhost fixture")
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/explore/111111111111111111111111" {
			http.Redirect(w, r, "/website-login/error?code=300012&xsec_token=SECRET", http.StatusFound)
			return
		}
		_, _ = w.Write([]byte("<title>fixture</title>local diagnostic test"))
	}))
	defer srv.Close()
	// This disposable localhost fixture has no account data; hosted Linux CI
	// cannot provide Chromium's user-namespace sandbox.
	l := launcher.New().Bin(bin).Headless(true).NoSandbox(true).Leakless(false).Set("no-proxy-server").Set("disable-background-networking")
	b := rod.New().ControlURL(l.MustLaunch()).MustConnect()
	defer l.Cleanup()
	defer b.MustClose()
	p := b.MustPage()
	trace := newReadTrace()
	stop := trace.attach(p)
	p.MustNavigate(srv.URL + "/explore/111111111111111111111111?xsec_token=SECRET").MustWaitLoad()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		trace.mu.Lock()
		ready := len(trace.d.Documents) >= 2 && trace.d.Documents[1].HTTPStatus == 200
		trace.mu.Unlock()
		if ready {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	stop()
	d := trace.finish(nil)
	if len(d.Documents) < 2 || d.Documents[0].HTTPStatus != 302 || d.Documents[1].HTTPStatus != 200 {
		t.Fatalf("missing actual navigation: %+v", d)
	}
	raw, _ := json.Marshal(d)
	if strings.Contains(string(raw), "SECRET") {
		t.Fatal(string(raw))
	}
}
