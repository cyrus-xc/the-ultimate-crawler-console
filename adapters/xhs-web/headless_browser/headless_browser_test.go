package headless_browser

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestNavigate(t *testing.T) {

	bin := os.Getenv("XHS_DIAGNOSTIC_TEST_BROWSER")
	if bin == "" {
		t.Skip("set XHS_DIAGNOSTIC_TEST_BROWSER for localhost fixture")
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("<title>local fixture</title>ready"))
	}))
	defer srv.Close()
	profile := filepath.Join(t.TempDir(), "profile")
	options := []Option{WithHeadless(true), WithChromeBinPath(bin), WithUserDataDir(profile), WithStealthJS(false), WithExtraFlags(map[string]string{"no-proxy-server": "", "disable-background-networking": ""})}
	b := New(options...)
	p := b.NewPage()
	p.MustNavigate(srv.URL).MustWaitLoad()
	p.MustEval(`() => localStorage.setItem('fixture','preserved')`)
	b.Close()
	if _, err := os.Stat(profile); err != nil {
		t.Fatal("persistent profile removed", err)
	}
	b = New(options...)
	defer b.Close()
	p = b.NewPage()
	p.MustNavigate(srv.URL).MustWaitLoad()
	if p.MustEval(`() => localStorage.getItem('fixture')`).Str() != "preserved" {
		t.Fatal("browser session storage lost")
	}

}
