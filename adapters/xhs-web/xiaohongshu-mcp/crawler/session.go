package crawler

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/proto"
	"github.com/sirupsen/logrus"
	"github.com/xpzouying/headless_browser"
	"github.com/xpzouying/xiaohongshu-mcp/browser"
	"github.com/xpzouying/xiaohongshu-mcp/configs"
	"github.com/xpzouying/xiaohongshu-mcp/cookies"
)

const SessionVersion = "crawler_browser_session_v1"

// maxEngineTabs bounds the identity tabs one worker browser keeps. A worker
// reads one page at a time, so the rest only wait for reuse; entity runs rarely
// revisit an author, and 16 idle tabs per worker held ~14 GB across three
// workers, starving the machine into CRAWLER_RESOURCE_BUSY.
const maxEngineTabs = 4
const BrowserResponseTimeout = 10 * time.Second

// MaxConcurrentTabs bounds how many reads one browser runs at the same time,
// each in its own tab. XHS counts every browser profile as a logged-in PC, so
// parallelism belongs inside one browser, not in more browsers (more workers).
const MaxConcurrentTabs = 10

// TabsFromEnv is the serve's concurrency: XHS_CRAWLER_TABS, 1..10, default 1
// (one read at a time, the behaviour before concurrent tabs).
func TabsFromEnv() int {
	n, _ := strconv.Atoi(strings.TrimSpace(os.Getenv("XHS_CRAWLER_TABS")))
	if n < 1 {
		return 1
	}
	if n > MaxConcurrentTabs {
		return MaxConcurrentTabs
	}
	return n
}

// errBrowserInterrupted 表示读取过程中浏览器/页面上下文被销毁（rod Must* panic）。
// 用哨兵错误而非裸字符串，使 readSession 能识别并“重建浏览器 + 从同一断点重试一次”。
var errBrowserInterrupted = errors.New("CRAWLER_BROWSER_INTERRUPTED")

// networkRetryDelay 是网络层失败（连接被关闭/重置、代理）后重试同一请求前的等待。
var networkRetryDelay = 2 * time.Second

// All requests for a saved login use one engine in the local session service.
// Up to `concurrency` reads run at once, each in its own identity tab; a tab is
// used by one read at a time (reads of one author queue for that author's tab,
// which also keeps its list position). mu guards every field below it; the
// browser generation lets concurrent failures reset a browser only once.
type Engine struct {
	slots       chan struct{}
	concurrency int
	mu          sync.Mutex
	gen         int64
	busy        map[string]bool
	tabCap      int
	browser     *headless_browser.Browser
	tabs        map[string]*rod.Page
	owners      map[string]string
	used        map[string]time.Time
	cookieHash  [32]byte
	launches    int64 // cumulative browser launches on this serve (diagnostics)
	launchWhy   string
	openBrowser func() *headless_browser.Browser
	readPage    func(context.Context, *rod.Page, Request) (map[string]any, error)
}

func New() *Engine { return NewWithTabs(TabsFromEnv()) }

func NewWithTabs(n int) *Engine {
	if n < 1 {
		n = 1
	}
	if n > MaxConcurrentTabs {
		n = MaxConcurrentTabs
	}
	tabCap := maxEngineTabs
	if n > tabCap {
		tabCap = n
	}
	return &Engine{slots: make(chan struct{}, n), concurrency: n, busy: map[string]bool{}, tabCap: tabCap, tabs: map[string]*rod.Page{}, owners: map[string]string{}, used: map[string]time.Time{}, openBrowser: openSessionBrowser, readPage: readPage}
}

// Concurrency is how many reads this engine runs at once.
func (e *Engine) Concurrency() int { return e.concurrency }

func (e *Engine) Close() { e.mu.Lock(); defer e.mu.Unlock(); e.reset(false) }

// resetGen resets the browser only if it is still the generation a failing
// read used; a sibling read may already have replaced it.
func (e *Engine) resetGen(gen int64, force bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.gen == gen {
		e.reset(force)
	}
}

// reset closes the browser and forgets its tabs. The caller holds mu.
func (e *Engine) reset(force bool) {
	if e.browser != nil {
		if force {
			e.browser.ForceClose()
		} else {
			e.browser.Close()
		}
	}
	e.browser = nil
	e.tabs = map[string]*rod.Page{}
	e.used = map[string]time.Time{}
	e.busy = map[string]bool{}
	e.gen++
}
func cookieHash() [32]byte {
	b, _ := os.ReadFile(cookies.GetCookiesFilePath())
	return sha256.Sum256(b)
}
func (e *Engine) ensureBrowser() (*headless_browser.Browser, int64) {
	e.mu.Lock()
	defer e.mu.Unlock()
	reason := "first"
	if e.browser != nil {
		// A browser killed outside this process (a stopped stage's leftover, a
		// crash, OOM) leaves a live handle here that answers no CDP command.
		// Rebuild it instead of handing dead tabs to the next read. Probe twice
		// before declaring death: a single 1s CDP hiccup under load must not
		// tear down a healthy browser (that shows up as "读一帖就重开浏览器").
		alive := e.browser.Alive() || e.browser.Alive()
		if alive {
			return e.browser, e.gen
		}
		logrus.Infof("[ensureBrowser] Alive=false -> reset(true)+重开浏览器")
		e.reset(true)
		reason = "previous_browser_dead"
	}
	// NOTE: a changed cookies file must NOT tear the browser down. Saving rotated
	// cookies (or another worker saving them) used to reset the browser on the
	// next read — that is the "频繁重启浏览器" churn. The live browser already
	// holds a working session; a genuinely dead browser is caught by Alive above.
	e.launches++
	e.launchWhy = reason
	logrus.Infof("[ensureBrowser] 新建浏览器 #%d reason=%s", e.launches, reason)
	e.browser = e.openBrowser()
	e.cookieHash = cookieHash()
	return e.browser, e.gen
}
func openSessionBrowser() *headless_browser.Browser {
	store := cookies.NewLoadCookie(cookies.GetCookiesFilePath())
	profile := os.Getenv("XHS_BROWSER_PROFILE")
	if profile != "" {
		_ = os.MkdirAll(filepath.Clean(profile), 0700)
	}
	// 默认无头；XHS_CRAWLER_HEADFUL=true 时弹可见窗口以便人工观察。两者共用同一
	// 指纹 seed / profile / cookies，可见模式保存的会话仍能被无头采集复用。
	headless := !configs.HeadfulFromEnv()
	return browser.NewBrowser(headless, browser.WithFingerprintSeed(configs.ResolveFingerprintSeed(store)), browser.WithProxy(configs.ProxyFromEnv()), browser.WithProfileDir(profile))
}

// OpenDesktop reuses the live collector browser. It never clears account
// protection or starts a collection. A closed session cannot resurrect an old
// error page: a new session starts on the homepage for manual inspection.
func (e *Engine) OpenDesktop(ctx context.Context) (fresh bool, err error) {
	e.ensureBrowser()
	e.mu.Lock()
	defer e.mu.Unlock()
	var page *rod.Page
	var latest time.Time
	for key, p := range e.tabs {
		if e.used[key].After(latest) {
			page, latest = p, e.used[key]
		}
	}
	if page == nil {
		page = e.page(ctx, "operator-desktop")
		if err = page.Context(ctx).Navigate("https://www.xiaohongshu.com"); err != nil {
			return true, err
		}
		fresh = true
	}
	_, err = page.Context(ctx).Activate()
	return fresh, err
}
func (e *Engine) tabKey(r Request) string {
	switch r.Kind {
	case "search":
		h := sha256.Sum256([]byte(r.Keyword))
		return "search:" + hex.EncodeToString(h[:])
	case "profile":
		return "user:" + r.ID
	case "detail":
		uid := r.UserID
		if uid == "" {
			e.mu.Lock()
			uid = e.owners[r.ID]
			e.mu.Unlock()
		}
		if uid != "" {
			return "user:" + uid
		}
		return "unresolved"
	default:
		return "poi:" + r.ID
	}
}

// acquirePage waits until no other read uses this identity tab, then returns
// it (opening one if needed) and a release func. A browser replaced while
// waiting ends the attempt as interrupted so it retries on the new browser.
func (e *Engine) acquirePage(ctx context.Context, key string, gen int64) (*rod.Page, func(), error) {
	for {
		e.mu.Lock()
		if e.gen != gen {
			current := e.gen
			e.mu.Unlock()
			logrus.Infof("[acquirePage] browser replaced while waiting key=%s gen=%d current=%d", key, gen, current)
			return nil, nil, errBrowserInterrupted
		}
		if !e.busy[key] {
			e.busy[key] = true
			// Opening a tab keeps the 10 s page-response window it always had. A
			// tab that cannot be opened panics (the browser is cancelled); release
			// the key and the lock first so sibling reads are not blocked forever.
			openCtx, openCancel := context.WithTimeout(ctx, BrowserResponseTimeout)
			var p *rod.Page
			func() {
				defer func() {
					if v := recover(); v != nil {
						delete(e.busy, key)
						e.mu.Unlock()
						openCancel()
						panic(v)
					}
				}()
				p = e.page(openCtx, key)
			}()
			openCancel()
			e.mu.Unlock()
			return p, func() {
				e.mu.Lock()
				if e.gen == gen {
					delete(e.busy, key)
					e.used[key] = time.Now()
				}
				e.mu.Unlock()
			}, nil
		}
		e.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil, nil, ctx.Err()
		case <-time.After(50 * time.Millisecond):
		}
	}
}

// page returns the identity tab for key. The caller holds mu and has marked
// key busy; only idle tabs are evicted to stay within tabCap.
func (e *Engine) page(ctx context.Context, key string) *rod.Page {
	e.used[key] = time.Now()
	if p := e.tabs[key]; p != nil {
		return p
	}
	// A large keyword run may discover thousands of authors. Keep one tab per
	// active identity, evicting the oldest idle tab to bound browser memory.
	if len(e.tabs) >= e.tabCap {
		oldest := ""
		var when time.Time
		for k := range e.tabs {
			if e.busy[k] {
				continue
			}
			if oldest == "" || e.used[k].Before(when) {
				oldest = k
				when = e.used[k]
			}
		}
		if oldest != "" {
			_ = e.tabs[oldest].Timeout(time.Second).Close()
			delete(e.tabs, oldest)
			delete(e.used, oldest)
		}
	}
	p := e.browser.NewPageContext(ctx)
	// Keep the tab's lifetime independent of this request's deadline.
	e.tabs[key] = p
	return p
}

// A health check executes in the active renderer. Slow collection or a quiet
// tab does not count as a hang while JavaScript still answers. Navigation can
// briefly invalidate execution contexts, so errors get the same 10s window.
func watchBrowser(ctx context.Context, probe func(context.Context) error, timeout time.Duration, hung func()) func() {
	ctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		last := time.Now()
		for {
			remaining := timeout - time.Since(last)
			if remaining <= 0 {
				if ctx.Err() == nil {
					hung()
				}
				return
			}
			check, stop := context.WithTimeout(ctx, remaining)
			err := probe(check)
			stop()
			if ctx.Err() != nil {
				return
			}
			if err == nil {
				last = time.Now()
			}
			delay := 100 * time.Millisecond
			if err == nil {
				delay = time.Second
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(delay):
			}
		}
	}()
	return func() { cancel(); <-done }
}

func (e *Engine) attempt(ctx context.Context, r Request, trace *readTrace) (result map[string]any, err error, hung bool, gen int64) {
	// Recover rod's Must* panics inside the attempt, so the watchdog is joined
	// before the engine is reset or another request starts.
	var pageCtx context.Context
	var b *headless_browser.Browser
	if deadline, ok := ctx.Deadline(); ok {
		logrus.Infof("[attempt] start kind=%s id=%s keyword=%q budget=%.1fs pageCtx=%v", r.Kind, r.ID, r.Keyword, time.Until(deadline).Seconds(), BrowserResponseTimeout)
	} else {
		logrus.Infof("[attempt] start kind=%s id=%s keyword=%q budget=unlimited pageCtx=%v", r.Kind, r.ID, r.Keyword, BrowserResponseTimeout)
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			err = errBrowserInterrupted
			if deadline, ok := recovered.(error); ok && errors.Is(deadline, context.DeadlineExceeded) {
				hung = ctx.Err() == nil
			}
			if pageCtx != nil && pageCtx.Err() == context.DeadlineExceeded && ctx.Err() == nil {
				hung = true
			}
			if hung && b != nil {
				logrus.Infof("[attempt] watchdog 触发 ForceClose kind=%s id=%s", r.Kind, r.ID)
				b.ForceClose()
			}
			// The panic value is the only evidence of why the page or browser went away
			// (HPC 2026-11-05: three interrupted reads in a row, cause unrecorded).
			logrus.Infof("[attempt] recovered panic kind=%s id=%s hung=%v err=%v panic=%s", r.Kind, r.ID, hung, err, panicText(recovered))
		}
		logrus.Infof("[attempt] end kind=%s id=%s err=%v hung=%v", r.Kind, r.ID, err, hung)
	}()
	b, gen = e.ensureBrowser()
	e.mu.Lock()
	launches, launchWhy := e.launches, e.launchWhy
	e.mu.Unlock()
	trace.mu.Lock()
	trace.d.BrowserLaunches = int(launches)
	trace.d.BrowserLaunchWhy = launchWhy
	trace.mu.Unlock()
	var pageCancel context.CancelFunc
	pageCtx, pageCancel = context.WithTimeout(ctx, BrowserResponseTimeout)
	defer pageCancel()
	// Waiting for this identity's tab uses the read's own deadline, not the
	// 10 s page-response window: another read of the same author may hold it.
	p, release, perr := e.acquirePage(ctx, e.tabKey(r), gen)
	if perr != nil {
		return nil, perr, false, gen
	}
	defer release()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var stalled atomic.Bool
	stop := watchBrowser(ctx, func(c context.Context) error {
		// Raw CDP avoids waiting on Rod's shared JavaScript-context mutex when
		// the collection goroutine itself is blocked in context initialization.
		_, err := (proto.RuntimeEvaluate{Expression: "1", ReturnByValue: true}).Call(p.Context(c))
		return err
	}, BrowserResponseTimeout, func() { stalled.Store(true); cancel(); b.ForceClose() })
	// Wall-clock 后备：rod 的 Context/Timeout 在某些死锁场景（如 scrollIntoView
	// 同步 layout 卡住 renderer）不会按预期取消，raw CDP 探针仍可能响应。若
	// readPage 实际墙钟超过 ctx deadline + margin，强制 ForceClose 浏览器。
	var wallClockStop chan struct{}
	if deadline, ok := ctx.Deadline(); ok {
		wallClockStop = make(chan struct{})
		go func() {
			margin := 10 * time.Second
			if r.Kind == "search" {
				margin = 30 * time.Second
			}
			timer := time.NewTimer(time.Until(deadline) + margin)
			defer timer.Stop()
			select {
			case <-timer.C:
				logrus.Warnf("[attempt] wall-clock watchdog 触发 kind=%s id=%s keyword=%q", r.Kind, r.ID, r.Keyword)
				stalled.Store(true)
				cancel()
				b.ForceClose()
			case <-wallClockStop:
			}
		}()
	}
	defer func() {
		if wallClockStop != nil {
			close(wallClockStop)
		}
		stop()
		hung = stalled.Load()
	}()
	stopTrace := trace.attach(p.Context(ctx))
	defer stopTrace()
	result, err = e.readPage(ctx, p, r)
	return
}
func (e *Engine) readSession(ctx context.Context, r Request, trace *readTrace) (map[string]any, error) {
	for attempt := 0; attempt < 2; attempt++ {
		result, err, hung, gen := e.attempt(ctx, r, trace)
		logrus.Infof("[readSession] attempt=%d kind=%s id=%s keyword=%q result=%v err=%v hung=%v ctx_err=%v", attempt, r.Kind, r.ID, r.Keyword, result != nil, err, hung, ctx.Err())
		if hung {
			// ForceClose already terminated this generation's browser, never other Chrome windows.
			e.mu.Lock()
			if e.gen == gen {
				e.browser = nil
				e.tabs = map[string]*rod.Page{}
				e.used = map[string]time.Time{}
				e.busy = map[string]bool{}
				e.gen++
			}
			e.mu.Unlock()
			trace.mu.Lock()
			trace.d.BrowserRestarts++
			trace.mu.Unlock()
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			if attempt == 0 {
				continue
			}
			// Leave a fresh browser ready for the next checkpointed request, but do
			// not loop indefinitely on a repeatedly hanging page.
			e.ensureBrowser()
			return nil, errors.New("CRAWLER_BROWSER_UNRESPONSIVE")
		}
		// The renderer died mid-read but the engine did not hang (e.g. the page
		// context was destroyed): rebuild the browser and retry the SAME request
		// once, so the caller resumes from the same checkpoint instead of losing
		// the item. Bounded to a single retry; a repeated interruption surfaces as
		// the error for the operator/self-heal path to handle.
		// A network-layer failure before the page loaded (connection closed or
		// reset, proxy) is usually transient: wait briefly and retry the SAME
		// request once on the same browser. A repeat surfaces as
		// CRAWLER_NETWORK_UNAVAILABLE, which the Python runtime counts toward its
		// three-consecutive-errors pause instead of failing every remaining item.
		if err != nil && isNetworkError(err) && attempt == 0 && ctx.Err() == nil {
			trace.mu.Lock()
			trace.d.NetworkRetries++
			trace.mu.Unlock()
			logrus.Infof("[readSession] 网络连接失败，%v 后重试同一请求 kind=%s id=%s err=%v", networkRetryDelay, r.Kind, r.ID, err)
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(networkRetryDelay):
			}
			continue
		}
		if err != nil && errors.Is(err, errBrowserInterrupted) && attempt == 0 && ctx.Err() == nil {
			trace.mu.Lock()
			trace.d.BrowserRestarts++
			trace.mu.Unlock()
			logrus.Infof("[readSession] 浏览器中断，重建浏览器并重试同一请求 note=%s kind=%s", r.ID, r.Kind)
			e.resetGen(gen, true)
			continue
		}
		if err == nil {
			if err = e.learnOwners(r, result); err != nil {
				return nil, err
			}
			// Update saved cookies only after a successful, unrestricted read. Never
			// overwrite a login file that another process changed during collection.
			e.mu.Lock()
			current, known := e.browser, e.cookieHash
			e.mu.Unlock()
			// A guest page's cookies are a logged-out session: never save them over the login.
			if _, restricted := result["access_diagnostic"]; !restricted && result["guest_session"] != true && current != nil && cookieHash() == known {
				saved, cancel := context.WithTimeout(ctx, 2*time.Second)
				data, saveErr := current.Cookies(saved)
				cancel()
				e.mu.Lock()
				if saveErr == nil && cookieHash() == e.cookieHash {
					store := cookies.NewLoadCookie(cookies.GetCookiesFilePath())
					if store.SaveCookies(data) == nil {
						e.cookieHash = cookieHash()
					}
				}
				e.mu.Unlock()
			}
		}
		// CRAWLER_RELOGIN_REQUIRED (access_state.go) leaves the login page on its
		// tab: the browser is not reset, so the QR login stays on screen for the
		// person and no second login window is opened.
		return result, err
	}
	return nil, errors.New("CRAWLER_BROWSER_UNRESPONSIVE")
}
func (e *Engine) learnOwners(r Request, result map[string]any) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	// Normalize typed raw structures without recording tokens or response text.
	data, _ := json.Marshal(result["raw"])
	var raw map[string]any
	_ = json.Unmarshal(data, &raw)
	add := func(note map[string]any, id string) string {
		user, _ := note["user"].(map[string]any)
		uid, _ := user["userId"].(string)
		if idPattern.MatchString(id) && idPattern.MatchString(uid) {
			e.owners[id] = uid
			return uid
		}
		return ""
	}
	if note, ok := raw["note"].(map[string]any); ok {
		id, _ := note["noteId"].(string)
		uid := add(note, id)
		if r.UserID != "" && uid != r.UserID {
			return errors.New("DETAIL_AUTHOR_MISMATCH")
		}
		if uid != "" && e.tabs["unresolved"] != nil && !e.busy["unresolved"] && r.Kind == "detail" && r.UserID == "" {
			p := e.tabs["unresolved"]
			delete(e.tabs, "unresolved")
			delete(e.used, "unresolved")
			if e.tabs["user:"+uid] == nil {
				e.tabs["user:"+uid] = p
				e.used["user:"+uid] = time.Now()
			} else {
				_ = p.Timeout(time.Second).Close()
			}
		}
	}
	var visit func(any)
	visit = func(value any) {
		switch v := value.(type) {
		case []any:
			for _, item := range v {
				visit(item)
			}
		case map[string]any:
			if card, ok := v["noteCard"].(map[string]any); ok {
				id, _ := v["id"].(string)
				add(card, id)
			}
			for _, name := range []string{"feeds", "notes"} {
				if child, ok := v[name]; ok {
					visit(child)
				}
			}
		}
	}
	visit(raw)
	return nil
}
