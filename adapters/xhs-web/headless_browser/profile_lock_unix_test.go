//go:build !windows

package headless_browser

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func lockProfile(t *testing.T, host string, pid int) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.Symlink(host+"-"+strconv.Itoa(pid), filepath.Join(dir, "SingletonLock")); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestProfileWaitFollowsLiveOwnerUntilExit(t *testing.T) {
	owner := exec.Command("sleep", "30")
	if err := owner.Start(); err != nil {
		t.Fatal(err)
	}
	host, _ := os.Hostname()
	dir := lockProfile(t, host, owner.Process.Pid)
	go func() { time.Sleep(300 * time.Millisecond); _ = owner.Process.Kill(); _ = owner.Wait() }()
	start := time.Now()
	if _, free := waitProfileReleased(dir, 5*time.Second); !free {
		t.Fatal("profile reported busy after its owner exited")
	}
	if waited := time.Since(start); waited < 250*time.Millisecond {
		t.Fatalf("returned after %s while the owner was alive", waited)
	}
}

func TestProfileWaitIgnoresDeadOrForeignOwners(t *testing.T) {
	gone := exec.Command("true")
	if err := gone.Run(); err != nil {
		t.Fatal(err)
	}
	host, _ := os.Hostname()
	for name, dir := range map[string]string{
		"dead":    lockProfile(t, host, gone.Process.Pid),
		"foreign": lockProfile(t, "other-host", os.Getpid()),
		"none":    t.TempDir(),
	} {
		start := time.Now()
		if _, free := waitProfileReleased(dir, 5*time.Second); !free || time.Since(start) > time.Second {
			t.Fatalf("%s owner blocked the launch", name)
		}
	}
}

func TestProfileWaitGivesUpOnAnOwnerThatStays(t *testing.T) {
	host, _ := os.Hostname()
	dir := lockProfile(t, host, os.Getpid())
	if pid, free := waitProfileReleased(dir, 200*time.Millisecond); free || pid != os.Getpid() {
		t.Fatalf("free=%v pid=%d for a live owner", free, pid)
	}
}
