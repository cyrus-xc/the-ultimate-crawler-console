package xiaohongshu

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"github.com/go-rod/rod"
)

func captureAlertPage(page *rod.Page, code string) {
	dir := os.Getenv("XHS_CRAWLER_ALERT_DIR")
	if dir == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(page.GetContext()), 3*time.Second)
	defer cancel()
	shot, err := page.Context(ctx).Screenshot(false, nil)
	if err != nil {
		shot = nil
	}
	// Only viewport pixels, not browser chrome, cookies, URLs or DOM dumps.
	// Failure is recorded too, so an older screenshot cannot impersonate it.
	_ = saveAlertPage(dir, code, shot, time.Now())
}

func saveAlertPage(dir, code string, shot []byte, now time.Time) error {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	name := ""
	if len(shot) > 0 && len(shot) <= 10*1024*1024 {
		f, err := os.CreateTemp(dir, "page-*.png")
		if err != nil {
			return err
		}
		_, err = f.Write(shot)
		closeErr := f.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
		name = filepath.Base(f.Name())
	}
	b, _ := json.Marshal(map[string]any{"error": code, "captured_at": now.UTC().Format(time.RFC3339Nano), "file": name})
	f, err := os.CreateTemp(dir, "incident-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), filepath.Join(dir, "incident.json"))
}
