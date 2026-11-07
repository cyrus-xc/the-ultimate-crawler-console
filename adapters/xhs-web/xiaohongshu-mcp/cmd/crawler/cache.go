package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/sirupsen/logrus"
)

const (
	defaultCacheTTL   = 24 * time.Hour
	cleanupThrottle   = time.Hour
	markerFileName    = ".last_cache_cleanup"
)

// cleanupExpiredCache 在 Go 进程启动时清理过期的 crawler 响应缓存。
// 扫描路径优先级：XHS_CRAWLER_STORE > XHS_CRAWLER_CACHE > data/cache/xhs_crawler。
// TTL 优先级：XHS_CRAWLER_CACHE_TTL_SECONDS > 24h。
// 通过 .last_cache_cleanup 标记把执行频率限制在最多每小时一次，避免 stdio
// 每请求都全量扫描。
func cleanupExpiredCache() {
	root := cacheRoot()
	ttl := cacheTTL()

	if info, err := os.Stat(root); err != nil || !info.IsDir() {
		logrus.Debugf("[cache-cleanup] root not found: %s", root)
		return
	}

	marker := filepath.Join(root, markerFileName)
	if shouldSkipCleanup(marker) {
		return
	}

	logrus.Infof("[cache-cleanup] scanning root=%s ttl=%s", root, ttl)
	start := time.Now()
	var scanned, removed, errs int
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			logrus.Debugf("[cache-cleanup] walk error %s: %v", path, err)
			return nil
		}
		if d.IsDir() || !strings.EqualFold(filepath.Ext(d.Name()), ".json") {
			return nil
		}
		if !isPrivateCacheFile(path, root) {
			return nil
		}
		scanned++
		expired, perr := cacheFileExpired(path, ttl)
		if perr != nil {
			logrus.Debugf("[cache-cleanup] parse failed %s: %v", path, perr)
			errs++
			return nil
		}
		if !expired {
			return nil
		}
		if rerr := os.Remove(path); rerr != nil {
			logrus.Debugf("[cache-cleanup] remove failed %s: %v", path, rerr)
			errs++
		} else {
			removed++
		}
		return nil
	})
	logrus.Infof("[cache-cleanup] done scanned=%d removed=%d errors=%d elapsed=%s",
		scanned, removed, errs, time.Since(start).Round(time.Millisecond))
	_ = touchMarker(marker)
}

func cacheRoot() string {
	if v := os.Getenv("XHS_CRAWLER_STORE"); v != "" {
		return filepath.Clean(v)
	}
	if v := os.Getenv("XHS_CRAWLER_CACHE"); v != "" {
		return filepath.Clean(v)
	}
	return "data/cache/xhs_crawler"
}

func cacheTTL() time.Duration {
	v := os.Getenv("XHS_CRAWLER_CACHE_TTL_SECONDS")
	if v == "" {
		return defaultCacheTTL
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return defaultCacheTTL
	}
	return time.Duration(n) * time.Second
}

func shouldSkipCleanup(marker string) bool {
	info, err := os.Stat(marker)
	if err != nil {
		return false
	}
	ago := time.Since(info.ModTime())
	if ago < cleanupThrottle {
		logrus.Debugf("[cache-cleanup] skipped, last run %s ago", ago.Round(time.Second))
		return true
	}
	return false
}

func isPrivateCacheFile(path, root string) bool {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return false
	}
	parts := strings.Split(rel, string(filepath.Separator))
	for i := 0; i < len(parts)-1; i++ {
		if parts[i] == "private" {
			return true
		}
	}
	return false
}

func cacheFileExpired(path string, ttl time.Duration) (bool, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return false, err
	}
	var rec struct {
		ObservedAt string `json:"observed_at"`
	}
	if err := json.Unmarshal(data, &rec); err != nil {
		return false, err
	}
	if rec.ObservedAt == "" {
		return false, nil
	}
	t, err := parseTime(rec.ObservedAt)
	if err != nil {
		return false, err
	}
	return time.Since(t) > ttl, nil
}

func parseTime(s string) (time.Time, error) {
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t, nil
	}
	return time.Parse(time.RFC3339, s)
}

func touchMarker(path string) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	_, _ = f.WriteString(time.Now().Format(time.RFC3339))
	return f.Close()
}
