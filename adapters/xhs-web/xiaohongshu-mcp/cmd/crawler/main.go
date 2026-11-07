package main

import (
	"context"
	"encoding/json"
	"github.com/sirupsen/logrus"
	"github.com/xpzouying/xiaohongshu-mcp/crawler"
	"github.com/xpzouying/xiaohongshu-mcp/humanize"
	"io"
	"os"
	"strings"
)

// debugLogMaxBytes rotates XHS_CRAWLER_DEBUG_LOG to <path>.1 when a process opens it.
const debugLogMaxBytes = 64 << 20

func main() { os.Exit(run()) }
func run() int {
	logrus.SetOutput(io.Discard) // stdout 只输出协议 JSON，避免 URL 令牌进入日志。
	// [TEMP DEBUG] XHS_CRAWLER_DEBUG_LOG=/path/to.log -> 把内部逐轮日志落到文件，
	// 用于定位详情读取卡在哪一步。设 XHS_CRAWLER_DEBUG_LEVEL=debug 打开 Debug 级。
	// stdout 仍只输出协议 JSON，URL 令牌不会进日志（logrus 只写文件）。
	if p := strings.TrimSpace(os.Getenv("XHS_CRAWLER_DEBUG_LOG")); p != "" {
		// Kept on for diagnosis on HPC: one older generation, bounded size.
		if st, err := os.Stat(p); err == nil && st.Size() > debugLogMaxBytes {
			_ = os.Rename(p, p+".1")
		}
		if f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600); err == nil {
			logrus.SetOutput(f)
			level := logrus.InfoLevel
			if strings.EqualFold(os.Getenv("XHS_CRAWLER_DEBUG_LEVEL"), "debug") {
				level = logrus.DebugLevel
			}
			logrus.SetLevel(level)
			logrus.Infof("[debug-log] opened %s level=%s pid=%d", p, level, os.Getpid())
		}
	}
	// 启动时清理过期响应缓存；每小时最多执行一次，避免 stdio 模式每请求都扫描。
	cleanupExpiredCache()
	enc := json.NewEncoder(os.Stdout)
	fail := func(code string) int {
		_ = enc.Encode(map[string]any{"success": false, "error": code, "version": crawler.Version})
		return 1
	}
	if len(os.Args) == 2 && os.Args[1] == "health" {
		_ = enc.Encode(map[string]any{"success": true, "version": crawler.Version, "transport": "stdio", "session_version": crawler.SessionVersion, "navigation_version": crawler.NavigationVersion, "share_selection_version": crawler.ShareSelectionVersion, "profile_walk_version": crawler.ProfileWalkVersion, "browser_watchdog_seconds": 10, "operations": []string{"search", "profile", "detail", "poi"}, "comment_modes": []string{"sample", crawler.LimitedLazyLoadOnScroll}, "comment_lazy_load_limit": 2, "search_unbounded": true, "profile_since": true, "concurrent_tabs": crawler.MaxConcurrentTabs, "scroll_pause": humanize.ScrollPolicy(), "diagnostics_version": crawler.DiagnosticsVersion, "login": "not_checked"})
		return 0
	}
	if len(os.Args) == 2 && os.Args[1] == "serve" {
		return serveSession()
	}
	if len(os.Args) != 2 || os.Args[1] != "read" {
		return fail("INVALID_COMMAND")
	}
	var req crawler.Request
	dec := json.NewDecoder(io.LimitReader(os.Stdin, 65537))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		return fail("INVALID_JSON")
	}
	var extra any
	if dec.Decode(&extra) != io.EOF {
		return fail("INVALID_JSON")
	}
	if req.Target == 0 && req.Kind != "search" && req.Kind != "profile" {
		req.Target = 50
	}
	if req.Seconds == 0 && req.Kind != "search" {
		req.Seconds = 45
		if req.CommentMode == crawler.LimitedLazyLoadOnScroll {
			req.Seconds = 300
		}
	}
	if err := req.Validate(); err != nil {
		return fail(crawler.ErrorCode(err))
	}
	if strings.ToLower(os.Getenv("ENABLE_XHS_BROWSER_NETWORK")) != "true" {
		return fail("CRAWLER_NETWORK_DISABLED")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	watchParent(ctx, cancel, os.Getppid())
	engine := crawler.New()
	defer engine.Close()
	data, err := engine.Read(ctx, req)
	if err != nil {
		_ = enc.Encode(map[string]any{"success": false, "error": crawler.ErrorCode(err), "version": crawler.Version, "diagnostics": crawler.ErrorDiagnostics(err)})
		return 1
	}
	_ = enc.Encode(map[string]any{"success": true, "version": crawler.Version, "data": data})
	return 0
}
