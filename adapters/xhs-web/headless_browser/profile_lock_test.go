package headless_browser

import (
	"os"
	"path/filepath"
	"testing"
)

// HPC 2026-11-06 05:11:49: a watchdog ForceClose ran in its own goroutine while
// the next read already launched a browser on the same persistent profile; the
// old Chrome still held SingletonLock and the launch panicked ("Failed to get
// the debug url ... SingletonLock: File exists").
func TestRelaunchWaitsForPreviousProfileOwner(t *testing.T) {
	bin := os.Getenv("XHS_DIAGNOSTIC_TEST_BROWSER")
	if bin == "" {
		t.Skip("set XHS_DIAGNOSTIC_TEST_BROWSER to a Chrome binary")
	}
	profile := filepath.Join(t.TempDir(), "profile")
	options := []Option{WithHeadless(true), WithChromeBinPath(bin), WithUserDataDir(profile), WithStealthJS(false), WithExtraFlags(map[string]string{"no-proxy-server": "", "disable-background-networking": ""})}
	first := New(options...)
	go first.ForceClose()
	var second *Browser
	func() {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("relaunch on a profile still being released panicked: %v", r)
			}
		}()
		second = New(options...)
	}()
	defer second.Close()
	if !second.Alive() {
		t.Fatal("relaunched browser does not answer CDP")
	}
}
