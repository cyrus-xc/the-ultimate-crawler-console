package headless_browser

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// A persistent profile admits one Chrome. Rod's Kill only signals the old
// browser (after a 1 s sleep) and never waits for it, and a watchdog closes a
// hung browser in its own goroutine; a launch that starts meanwhile aborts on
// the old owner's SingletonLock (HPC 2026-11-06, CRAWLER_BROWSER_INTERRUPTED).
const profileReleaseWait = 15 * time.Second

// profileOwner is the pid of the Chrome on this host holding dir's
// SingletonLock ("<hostname>-<pid>"), or 0 when none is recorded.
func profileOwner(dir string) int {
	target, err := os.Readlink(filepath.Join(dir, "SingletonLock"))
	if err != nil {
		return 0
	}
	i := strings.LastIndexByte(target, '-')
	if i <= 0 {
		return 0
	}
	if host, err := os.Hostname(); err != nil || target[:i] != host {
		return 0
	}
	pid, err := strconv.Atoi(target[i+1:])
	if err != nil || pid <= 0 {
		return 0
	}
	return pid
}

// waitProfileReleased waits until no live process on this host owns dir. It
// returns the last owner seen and whether the profile is free.
func waitProfileReleased(dir string, timeout time.Duration) (int, bool) {
	deadline := time.Now().Add(timeout)
	for {
		pid := profileOwner(dir)
		if pid == 0 || !processAlive(pid) {
			return pid, true
		}
		if !time.Now().Before(deadline) {
			return pid, false
		}
		time.Sleep(100 * time.Millisecond)
	}
}
