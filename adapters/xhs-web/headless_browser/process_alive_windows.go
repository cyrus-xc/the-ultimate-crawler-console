//go:build windows

package headless_browser

// Chrome on Windows locks a profile with a "lockfile", not a SingletonLock
// symlink, so profileOwner never reports an owner there.
func processAlive(pid int) bool { return false }
