//go:build !windows

package headless_browser

// Rod's Unix launcher already kills its process group.
func terminateOwnedTree(pid int) {}
