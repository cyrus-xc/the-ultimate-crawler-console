package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"github.com/sirupsen/logrus"
	"github.com/xpzouying/xiaohongshu-mcp/crawler"
	"github.com/xpzouying/xiaohongshu-mcp/xiaohongshu"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// An authenticated, loopback-only service keeps one browser alive across CLI
// and pipeline processes. No token, cookie, URL or request body is logged.
func serveSession() int {
	if protectSessionChildren() != nil {
		return 1
	}
	token := os.Getenv("XHS_SESSION_TOKEN")
	ready := os.Getenv("XHS_SESSION_READY")
	if len(token) < 32 || ready == "" {
		return 1
	}
	// serve 模式生命周期较长，启动时同样清理一次过期缓存。
	cleanupExpiredCache()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return 1
	}
	defer listener.Close()
	// Every way this service ends is logged, last line after the browser is
	// closed: HPC 2026-11-06 lost a service mid-cooldown with no trace of why.
	defer logrus.Infof("[serve] exited pid=%d", os.Getpid())
	engine := crawler.New()
	defer engine.Close()
	// The service must not outlive the stage that started it. A stopped stage
	// kills only its Python process tree; this detached service would become an
	// orphan holding the browser profile, so the next run cannot open a browser.
	// Watch the parent and exit (closing the browser) when it goes away.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	parent := os.Getppid()
	watchParent(ctx, cancel, parent)
	var mu sync.Mutex
	active := 0
	last := time.Now()
	closing := false
	activeReads := map[int]context.CancelFunc{}
	nextReadID := 1
	cancelReadsAndWait := func(timeout time.Duration) {
		mu.Lock()
		cancels := make([]context.CancelFunc, 0, len(activeReads))
		for _, c := range activeReads {
			cancels = append(cancels, c)
		}
		mu.Unlock()
		for _, c := range cancels {
			c()
		}
		deadline := time.Now().Add(timeout)
		for time.Now().Before(deadline) {
			mu.Lock()
			a := active
			mu.Unlock()
			if a == 0 {
				return
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
	mux := http.NewServeMux()
	decisions := &shareDecisions{}
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8192}
	authorized := func(w http.ResponseWriter, r *http.Request) bool {
		// Reject browser-origin requests even if a browser happens to know the port.
		if r.Header.Get("Origin") != "" || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+token)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return false
		}
		w.Header().Set("Content-Type", "application/json")
		return true
	}
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		if !authorized(w, r) {
			return
		}
		mu.Lock()
		defer mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "version": crawler.Version, "session_version": crawler.SessionVersion, "navigation_version": crawler.NavigationVersion, "share_selection_version": crawler.ShareSelectionVersion, "profile_walk_version": crawler.ProfileWalkVersion, "pid": os.Getpid(), "active": active, "closing": closing, "tabs": engine.Concurrency()})
	})
	mux.HandleFunc("/desktop", func(w http.ResponseWriter, r *http.Request) {
		if !authorized(w, r) {
			return
		}
		if r.Method != "POST" {
			http.Error(w, "method", 405)
			return
		}
		mu.Lock()
		if active > 0 || closing {
			mu.Unlock()
			http.Error(w, "collector busy", 409)
			return
		}
		active++
		mu.Unlock()
		defer func() { mu.Lock(); active--; mu.Unlock() }()
		ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
		defer cancel()
		fresh, err := engine.OpenDesktop(ctx)
		if err != nil {
			http.Error(w, "desktop unavailable", 503)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "new_session_page": fresh})
	})
	mux.HandleFunc("/read", func(w http.ResponseWriter, r *http.Request) {
		if !authorized(w, r) {
			return
		}
		if r.Method != "POST" {
			http.Error(w, "method", 405)
			return
		}
		enc := json.NewEncoder(w)
		fail := func(code string) {
			_ = enc.Encode(map[string]any{"success": false, "version": crawler.Version, "error": code})
		}
		if strings.ToLower(os.Getenv("ENABLE_XHS_BROWSER_NETWORK")) != "true" {
			fail("CRAWLER_NETWORK_DISABLED")
			return
		}
		var req crawler.Request
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 65536))
		dec.DisallowUnknownFields()
		if dec.Decode(&req) != nil {
			fail("INVALID_JSON")
			return
		}
		var extra any
		if dec.Decode(&extra) != io.EOF {
			fail("INVALID_JSON")
			return
		}
		if err := req.Validate(); err != nil {
			fail(crawler.ErrorCode(err))
			return
		}
		mu.Lock()
		if closing {
			mu.Unlock()
			fail("CRAWLER_SESSION_CLOSING")
			return
		}
		readID := nextReadID
		nextReadID++
		active++
		mu.Unlock()
		defer func() { mu.Lock(); active--; last = time.Now(); mu.Unlock() }()
		// Tie an in-flight read to the service lifetime: when the owning stage
		// goes away (stop / crash) the read is cancelled immediately instead of
		// holding the engine slot and delaying browser cleanup.
		readCtx, readCancel := context.WithCancel(r.Context())
		stopRead := context.AfterFunc(ctx, readCancel)
		defer stopRead()
		defer readCancel()
		mu.Lock()
		activeReads[readID] = readCancel
		mu.Unlock()
		defer func() {
			mu.Lock()
			delete(activeReads, readID)
			mu.Unlock()
		}()
		if req.SelectShare {
			w.Header().Set("Content-Type", "application/x-ndjson")
			readCtx = xiaohongshu.WithShareSelector(readCtx, decisions.selector(w, req.ID))
		}
		if req.ProfileWalk {
			anchors, skip := map[string]bool{}, map[string]bool{}
			for _, nid := range req.ProfileAnchors {
				anchors[nid] = true
			}
			for _, nid := range req.ProfileSkip {
				skip[nid] = true
			}
			w.Header().Set("Content-Type", "application/x-ndjson")
			readCtx = xiaohongshu.WithProfileWalk(readCtx, xiaohongshu.ProfileWalk{
				Anchors: anchors, Skip: skip,
				Before: func(c context.Context, nid string) error {
					admitted, err := decisions.exchange(c, w, "detail_start", nid, map[string]any{"profile_user_id": req.ID})
					if err != nil {
						return err
					}
					if !admitted {
						return context.Canceled
					}
					return nil
				},
				Select: func(c context.Context, nid, access string, raw json.RawMessage) (bool, error) {
					return decisions.exchange(c, w, "detail_ready", nid, map[string]any{"raw": raw, "xsec_token": access})
				},
				Observe: func(c context.Context, nid string, detail map[string]any) (bool, error) {
					return decisions.exchange(c, w, "profile_note", nid, detail)
				},
			})
		}
		data, err := engine.Read(readCtx, req)
		if err != nil {
			_ = enc.Encode(map[string]any{"success": false, "version": crawler.Version, "error": crawler.ErrorCode(err), "diagnostics": crawler.ErrorDiagnostics(err)})
			return
		}
		_ = enc.Encode(map[string]any{"success": true, "version": crawler.Version, "data": data})
	})
	mux.HandleFunc("/share-decision", func(w http.ResponseWriter, r *http.Request) {
		if authorized(w, r) {
			decisions.decide(w, r)
		}
	})
	mux.HandleFunc("/shutdown", func(w http.ResponseWriter, r *http.Request) {
		if !authorized(w, r) {
			return
		}
		if r.Method != "POST" {
			http.Error(w, "method", 405)
			return
		}
		mu.Lock()
		if closing {
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
			return
		}
		closing = true
		reads := active
		mu.Unlock()
		logrus.Infof("[serve] shutdown requested active=%d", reads)

		// If a read is in flight, cancel it and give it a short grace period to
		// return. This lets a stopped stage shut down cleanly instead of leaving
		// an orphan service holding the browser profile.
		cancelReadsAndWait(10 * time.Second)

		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
		go func() { _ = server.Shutdown(context.Background()) }()
	})
	port := listener.Addr().(*net.TCPAddr).Port
	data, _ := json.Marshal(map[string]any{"pid": os.Getpid(), "port": port, "session_version": crawler.SessionVersion})
	temp := ready + "." + strconv.Itoa(os.Getpid()) + ".tmp"
	if os.WriteFile(temp, data, 0600) != nil {
		return 1
	}
	if os.Rename(temp, ready) != nil {
		return 1
	}
	defer os.Remove(ready)
	done := make(chan struct{})
	defer close(done)
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				// The owning stage exited or was stopped: cancel in-flight reads,
				// then close the browser with a bounded shutdown so a stuck handler
				// cannot keep the service alive.
				mu.Lock()
				closing = true
				reads := active
				mu.Unlock()
				logrus.Infof("[serve] parent gone (started under pid=%d, now ppid=%d) active=%d", parent, os.Getppid(), reads)
				cancelReadsAndWait(5 * time.Second)
				shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer shutdownCancel()
				_ = server.Shutdown(shutdownCtx)
				return
			case <-ticker.C:
				mu.Lock()
				idle := active == 0 && time.Since(last) > 10*time.Minute
				if idle {
					closing = true
				}
				mu.Unlock()
				if idle {
					logrus.Infof("[serve] idle for 10m, retiring")
					_ = server.Shutdown(context.Background())
					return
				}
			}
		}
	}()
	// An explicit SIGTERM/SIGINT (stage stop) must also close the browser, not
	// leave a detached Chromium holding the profile.
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	defer signal.Stop(signals)
	go func() {
		select {
		case <-done:
		case sig := <-signals:
			mu.Lock()
			closing = true
			reads := active
			mu.Unlock()
			logrus.Infof("[serve] signal %v active=%d", sig, reads)
			// Cancel any in-flight read so the handler returns before shutdown.
			cancelReadsAndWait(5 * time.Second)
			shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer shutdownCancel()
			_ = server.Shutdown(shutdownCtx)
		}
	}()
	if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
		logrus.Infof("[serve] listener failed: %v", err)
		return 1
	}
	return 0
}
