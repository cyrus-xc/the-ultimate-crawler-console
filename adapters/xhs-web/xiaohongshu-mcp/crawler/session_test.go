package crawler

import (
	"context"
	"errors"
	"fmt"
	"github.com/go-rod/rod"
	"github.com/xpzouying/headless_browser"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestTabRoutingAndLearnedAuthors(t *testing.T) {
	e := New()
	uid := "111111111111111111111111"
	nid := "222222222222222222222222"
	a := e.tabKey(Request{Kind: "search", Keyword: "lemon"})
	if a != e.tabKey(Request{Kind: "search", Keyword: "lemon", SortBy: "最新"}) || a == e.tabKey(Request{Kind: "search", Keyword: "amalfi"}) {
		t.Fatal("keyword isolation")
	}
	if e.tabKey(Request{Kind: "detail", ID: nid, UserID: uid}) != e.tabKey(Request{Kind: "profile", ID: uid}) {
		t.Fatal("profile/detail not shared")
	}
	result := map[string]any{"raw": map[string]any{"feeds": []any{map[string]any{"id": nid, "noteCard": map[string]any{"user": map[string]any{"userId": uid}}}}}}
	if err := e.learnOwners(Request{Kind: "search"}, result); err != nil {
		t.Fatal(err)
	}
	if e.tabKey(Request{Kind: "detail", ID: nid}) != "user:"+uid {
		t.Fatal("author not learned")
	}
	mismatch := map[string]any{"raw": map[string]any{"note": map[string]any{"noteId": nid, "user": map[string]any{"userId": uid}}}}
	if err := e.learnOwners(Request{Kind: "detail", UserID: nid}, mismatch); ErrorCode(err) != "DETAIL_AUTHOR_MISMATCH" {
		t.Fatal(err)
	}
	if (Request{Kind: "search", Keyword: "ok", UserID: uid}).Validate() == nil {
		t.Fatal("invalid author accepted")
	}
}

func TestInterruptedReadRebuildsAndRetriesFromCheckpoint(t *testing.T) {
	bin := os.Getenv("XHS_DIAGNOSTIC_TEST_BROWSER")
	if bin == "" {
		t.Skip("localhost browser fixture opt-in")
	}
	root := t.TempDir()
	t.Setenv("COOKIES_PATH", filepath.Join(root, "cookies.json"))
	e := New()
	defer e.Close()
	launches := 0
	e.openBrowser = func() *headless_browser.Browser {
		launches++
		return headless_browser.New(headless_browser.WithChromeBinPath(bin), headless_browser.WithStealthJS(false), headless_browser.WithUserDataDir(filepath.Join(root, "profile")), headless_browser.WithExtraFlags(map[string]string{"no-proxy-server": "", "disable-background-networking": ""}))
	}
	uid := "111111111111111111111111"
	nid := "222222222222222222222222"
	calls := 0
	e.readPage = func(ctx context.Context, p *rod.Page, r Request) (map[string]any, error) {
		calls++
		if calls == 1 {
			// Simulate a destroyed renderer/page context mid-read.
			return nil, errBrowserInterrupted
		}
		if _, err := p.Context(ctx).Eval(`() => document.title`); err != nil {
			return nil, err
		}
		return map[string]any{"raw": map[string]any{"note": map[string]any{"noteId": r.ID, "user": map[string]any{"userId": uid}}}}, nil
	}
	request := Request{Kind: "detail", ID: nid, UserID: uid, Target: 1, Seconds: 5}
	result, err := e.Read(context.Background(), request)
	if err != nil {
		t.Fatalf("interrupted read was not retried: %v", err)
	}
	if calls != 2 {
		t.Fatalf("expected exactly one retry, calls=%d", calls)
	}
	// The retry rebuilds the browser (interruption is an edge case that may fix
	// it), then re-runs the SAME request so the caller keeps its checkpoint.
	if launches != 2 || result["diagnostics"].(readDiagnostic).BrowserRestarts != 1 {
		t.Fatalf("rebuild on interruption: launches=%d diag=%v", launches, result["diagnostics"])
	}
}

func TestNetworkFailureRetriesSameRequestOnceWithoutRelaunch(t *testing.T) {
	bin := os.Getenv("XHS_DIAGNOSTIC_TEST_BROWSER")
	if bin == "" {
		t.Skip("localhost browser fixture opt-in")
	}
	root := t.TempDir()
	t.Setenv("COOKIES_PATH", filepath.Join(root, "cookies.json"))
	defer func(d time.Duration) { networkRetryDelay = d }(networkRetryDelay)
	networkRetryDelay = 0
	e := New()
	defer e.Close()
	launches := 0
	e.openBrowser = func() *headless_browser.Browser {
		launches++
		return headless_browser.New(headless_browser.WithChromeBinPath(bin), headless_browser.WithStealthJS(false), headless_browser.WithUserDataDir(filepath.Join(root, "profile")), headless_browser.WithExtraFlags(map[string]string{"no-proxy-server": "", "disable-background-networking": ""}))
	}
	uid := "111111111111111111111111"
	calls := 0
	e.readPage = func(ctx context.Context, p *rod.Page, r Request) (map[string]any, error) {
		calls++
		if calls == 1 {
			return nil, errors.New("navigation failed: net::ERR_CONNECTION_CLOSED")
		}
		return map[string]any{"raw": map[string]any{"user": map[string]any{"userId": uid}}}, nil
	}
	result, err := e.Read(context.Background(), Request{Kind: "profile", ID: uid, Seconds: 5})
	if err != nil || calls != 2 || launches != 1 {
		t.Fatalf("network failure not retried once on the same browser: err=%v calls=%d launches=%d", err, calls, launches)
	}
	if got := result["diagnostics"].(readDiagnostic).NetworkRetries; got != 1 {
		t.Fatalf("network_retries=%d", got)
	}
	// A second consecutive network failure is reported, not retried forever.
	calls = 0
	e.readPage = func(ctx context.Context, p *rod.Page, r Request) (map[string]any, error) {
		calls++
		return nil, errors.New("navigation failed: net::ERR_CONNECTION_CLOSED")
	}
	if _, err = e.Read(context.Background(), Request{Kind: "profile", ID: uid, Seconds: 5}); ErrorCode(err) != "CRAWLER_NETWORK_UNAVAILABLE" || calls != 2 {
		t.Fatalf("repeat network failure: code=%s calls=%d", ErrorCode(err), calls)
	}
}

func TestSavedCookiesRotationDoesNotRelaunchBrowser(t *testing.T) {
	bin := os.Getenv("XHS_DIAGNOSTIC_TEST_BROWSER")
	if bin == "" {
		t.Skip("localhost browser fixture opt-in")
	}
	root := t.TempDir()
	cookiesPath := filepath.Join(root, "cookies.json")
	t.Setenv("COOKIES_PATH", cookiesPath)
	e := New()
	defer e.Close()
	launches := 0
	e.openBrowser = func() *headless_browser.Browser {
		launches++
		return headless_browser.New(headless_browser.WithChromeBinPath(bin), headless_browser.WithStealthJS(false), headless_browser.WithUserDataDir(filepath.Join(root, "profile")), headless_browser.WithExtraFlags(map[string]string{"no-proxy-server": "", "disable-background-networking": ""}))
	}
	nid := "222222222222222222222222"
	e.readPage = func(ctx context.Context, p *rod.Page, r Request) (map[string]any, error) {
		return map[string]any{"raw": map[string]any{"note": map[string]any{"noteId": r.ID, "user": map[string]any{"userId": "111111111111111111111111"}}}}, nil
	}
	request := Request{Kind: "detail", ID: nid, UserID: "111111111111111111111111", Target: 1, Seconds: 5}
	if _, err := e.Read(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	// Rotate the saved cookies as a live session would. The browser already holds
	// a working session; it must be reused, not torn down and relaunched.
	if err := os.WriteFile(cookiesPath, []byte(`[{"name":"web_session","value":"rotated","domain":".xiaohongshu.com"}]`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Read(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	if launches != 1 {
		t.Fatalf("cookie rotation relaunched the browser: launches=%d", launches)
	}
}

func TestWatchdogResponsiveCancelAndTransientErrors(t *testing.T) {
	for _, responsive := range []bool{true, false} {
		ctx, cancel := context.WithCancel(context.Background())
		var triggered atomic.Bool
		stop := watchBrowser(ctx, func(c context.Context) error {
			if responsive {
				return nil
			}
			<-c.Done()
			return c.Err()
		}, 1500*time.Millisecond, func() { triggered.Store(true) })
		if responsive {
			time.Sleep(2200 * time.Millisecond)
		} else {
			time.Sleep(20 * time.Millisecond)
			cancel()
		}
		stop()
		cancel()
		if triggered.Load() {
			t.Fatal("responsive/cancelled request restarted")
		}
	}
	var calls atomic.Int32
	var triggered atomic.Bool
	stop := watchBrowser(context.Background(), func(context.Context) error {
		if calls.Add(1) == 1 {
			return errors.New("navigation")
		}
		return nil
	}, 1500*time.Millisecond, func() { triggered.Store(true) })
	time.Sleep(1800 * time.Millisecond)
	stop()
	if triggered.Load() || calls.Load() < 2 {
		t.Fatal("transient navigation error")
	}
}

func TestSessionRealBrowserReuseAndTenSecondRecovery(t *testing.T) {
	bin := os.Getenv("XHS_DIAGNOSTIC_TEST_BROWSER")
	if bin == "" {
		t.Skip("localhost browser fixture opt-in")
	}
	root := t.TempDir()
	t.Setenv("COOKIES_PATH", filepath.Join(root, "cookies.json"))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("<title>local session test</title><p>ready</p>"))
	}))
	defer srv.Close()
	e := New()
	defer e.Close()
	launches := 0
	e.openBrowser = func() *headless_browser.Browser {
		launches++
		return headless_browser.New(headless_browser.WithChromeBinPath(bin), headless_browser.WithStealthJS(false), headless_browser.WithUserDataDir(filepath.Join(root, "profile")), headless_browser.WithExtraFlags(map[string]string{"no-proxy-server": "", "disable-background-networking": ""}))
	}
	uid := "111111111111111111111111"
	nid := "222222222222222222222222"
	var pageIDs []string
	hang := false
	hungOnce := false
	e.readPage = func(ctx context.Context, p *rod.Page, r Request) (map[string]any, error) {
		pageIDs = append(pageIDs, string(p.TargetID))
		if err := p.Context(ctx).Navigate(srv.URL); err != nil {
			return nil, err
		}
		if hang && !hungOnce {
			hungOnce = true
			_, err := p.Context(ctx).Eval(`() => { while (true) {} }`)
			return nil, err
		}
		// DOM reading after navigation verifies that reused page events survive the
		// previous request's cancellation (a page-context lifetime regression).
		if _, err := p.Context(ctx).Eval(`() => document.title`); err != nil {
			return nil, err
		}
		if r.Kind == "detail" {
			return map[string]any{"raw": map[string]any{"note": map[string]any{"noteId": r.ID, "user": map[string]any{"userId": uid}}}}, nil
		}
		return map[string]any{"raw": map[string]any{}}, nil
	}
	requests := []Request{{Kind: "search", Keyword: "lemon", Target: 1, Seconds: 5}, {Kind: "search", Keyword: "lemon", Target: 1, Seconds: 5}, {Kind: "profile", ID: uid, Target: 1, Seconds: 5}, {Kind: "detail", ID: nid, UserID: uid, Target: 1, Seconds: 5}}
	for _, r := range requests {
		if _, err := e.Read(context.Background(), r); err != nil {
			t.Fatal(err)
		}
	}
	if launches != 1 || pageIDs[0] != pageIDs[1] || pageIDs[2] != pageIDs[3] || pageIDs[0] == pageIDs[2] {
		t.Fatalf("wrong reuse launches=%d ids=%v", launches, pageIDs)
	}
	hang = true
	start := time.Now()
	result, err := e.Read(context.Background(), requests[3])
	elapsed := time.Since(start)
	if err != nil {
		t.Fatal(err)
	}
	if launches != 2 || elapsed < 10*time.Second || elapsed > 30*time.Second || result["diagnostics"].(readDiagnostic).BrowserRestarts != 1 {
		t.Fatalf("recovery launches=%d elapsed=%v result=%v", launches, elapsed, result)
	}
	t.Logf("renderer stall recovered after %s; launches=%d; keyword and user tabs reused", elapsed, launches)
	// Access restrictions are application responses, never restart triggers.
	e.readPage = func(context.Context, *rod.Page, Request) (map[string]any, error) {
		return nil, errors.New("CRAWLER_ACCESS_RESTRICTED")
	}
	if _, err = e.Read(context.Background(), requests[3]); ErrorCode(err) != "CRAWLER_ACCESS_RESTRICTED" || launches != 2 {
		t.Fatal("restriction restarted browser", err, launches)
	}
}

func TestConcurrentTabsRunAuthorsTogetherButOneAuthorAtATime(t *testing.T) {
	bin := os.Getenv("XHS_DIAGNOSTIC_TEST_BROWSER")
	if bin == "" {
		t.Skip("localhost browser fixture opt-in")
	}
	root := t.TempDir()
	t.Setenv("COOKIES_PATH", filepath.Join(root, "cookies.json"))
	e := NewWithTabs(3)
	defer e.Close()
	launches := 0
	e.openBrowser = func() *headless_browser.Browser {
		launches++
		return headless_browser.New(headless_browser.WithChromeBinPath(bin), headless_browser.WithStealthJS(false), headless_browser.WithUserDataDir(filepath.Join(root, "profile")), headless_browser.WithExtraFlags(map[string]string{"no-proxy-server": "", "disable-background-networking": ""}))
	}
	var mu sync.Mutex
	running, peak := 0, 0
	perAuthor := map[string]int{}
	authorPeak := 0
	e.readPage = func(ctx context.Context, p *rod.Page, r Request) (map[string]any, error) {
		mu.Lock()
		running++
		perAuthor[r.UserID]++
		if running > peak {
			peak = running
		}
		if perAuthor[r.UserID] > authorPeak {
			authorPeak = perAuthor[r.UserID]
		}
		mu.Unlock()
		time.Sleep(400 * time.Millisecond)
		mu.Lock()
		running--
		perAuthor[r.UserID]--
		mu.Unlock()
		return map[string]any{"raw": map[string]any{"note": map[string]any{"noteId": r.ID, "user": map[string]any{"userId": r.UserID}}}}, nil
	}
	authors := []string{"111111111111111111111111", "333333333333333333333333", "555555555555555555555555", "111111111111111111111111"}
	var wg sync.WaitGroup
	errs := make(chan error, len(authors))
	for i, uid := range authors {
		wg.Add(1)
		go func(i int, uid string) {
			defer wg.Done()
			nid := fmt.Sprintf("%024x", i+1)
			_, err := e.Read(context.Background(), Request{Kind: "detail", ID: nid, UserID: uid, Target: 1, Seconds: 5})
			errs <- err
		}(i, uid)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if peak < 2 {
		t.Fatalf("reads of different authors did not overlap: peak=%d", peak)
	}
	if peak > 3 {
		t.Fatalf("more reads than tabs ran at once: peak=%d", peak)
	}
	if authorPeak != 1 {
		t.Fatalf("one author's tab served two reads at once: %d", authorPeak)
	}
	if launches != 1 {
		t.Fatalf("concurrent reads launched more than one browser: %d", launches)
	}
}

func TestTabsFromEnvIsBoundedAndDefaultsToOne(t *testing.T) {
	for value, want := range map[string]int{"": 1, "0": 1, "abc": 1, "3": 3, "10": 10, "99": MaxConcurrentTabs} {
		t.Setenv("XHS_CRAWLER_TABS", value)
		if got := TabsFromEnv(); got != want {
			t.Fatalf("XHS_CRAWLER_TABS=%q -> %d, want %d", value, got, want)
		}
	}
	if NewWithTabs(10).tabCap != 10 || NewWithTabs(1).tabCap != maxEngineTabs {
		t.Fatal("tab cap must cover concurrent reads")
	}
}
