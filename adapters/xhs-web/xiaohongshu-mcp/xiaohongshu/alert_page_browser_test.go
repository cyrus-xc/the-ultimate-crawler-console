//go:build integration

package xiaohongshu

import (
	"encoding/json"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/launcher"
)

func TestAlertPageBrowser(t *testing.T) {
	bin := os.Getenv("XHS_SHARE_TEST_CHROME")
	if bin == "" {
		t.Skip("set XHS_SHARE_TEST_CHROME")
	}
	dir := t.TempDir()
	t.Setenv("XHS_CRAWLER_ALERT_DIR", dir)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("<title>安全限制</title><h1>请完成验证</h1>"))
	}))
	defer server.Close()
	l := launcher.New().Bin(bin).Headless(true).UserDataDir(t.TempDir()).Set("disable-background-networking").Set("no-first-run")
	endpoint, err := l.Launch()
	if err != nil {
		t.Fatal(err)
	}
	b := rod.New().ControlURL(endpoint).MustConnect()
	defer func() { b.MustClose(); l.Cleanup() }()
	page := b.MustPage(server.URL + "/website-login/captcha").MustWaitLoad()
	e := checkAccess(page)
	if a, ok := e.(*AccessError); !ok || a.Code != "CRAWLER_VERIFICATION_REQUIRED" {
		t.Fatal(e)
	}
	data, err := os.ReadFile(filepath.Join(dir, "incident.json"))
	if err != nil {
		t.Fatal(err)
	}
	var meta map[string]any
	if err = json.Unmarshal(data, &meta); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(filepath.Join(dir, meta["file"].(string)))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	dimensions, err := png.DecodeConfig(f)
	if err != nil || dimensions.Width < 100 || dimensions.Height < 100 {
		t.Fatalf("invalid screenshot: %v %v", dimensions, err)
	}
}
