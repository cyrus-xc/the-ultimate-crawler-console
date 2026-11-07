//go:build windows

package main

import (
	"context"
	"golang.org/x/sys/windows"
)

// Uncapped acquisition must not outlive a cancelled/crashed pipeline runner.
func watchParent(ctx context.Context, cancel context.CancelFunc, pid int) {
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		cancel()
		return
	}
	go func() {
		defer windows.CloseHandle(handle)
		for {
			result, err := windows.WaitForSingleObject(handle, 500)
			if err != nil || result == windows.WAIT_OBJECT_0 {
				cancel()
				return
			}
			select {
			case <-ctx.Done():
				return
			default:
			}
		}
	}()
}
