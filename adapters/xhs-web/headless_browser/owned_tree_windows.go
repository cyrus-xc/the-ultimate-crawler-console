//go:build windows

package headless_browser

import (
	"context"
	"os/exec"
	"strconv"
	"syscall"
	"time"
)

// Rod's Windows Kill terminates only the browser parent. Target the exact
// launcher-owned PID tree so a hung renderer cannot survive a restart.
func terminateOwnedTree(pid int) {
	if pid <= 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "taskkill.exe", "/PID", strconv.Itoa(pid), "/T", "/F")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	_ = cmd.Run()
}
