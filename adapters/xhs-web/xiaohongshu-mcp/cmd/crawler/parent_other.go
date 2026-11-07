//go:build !windows

package main

import (
	"context"
	"os"
	"time"
)

func watchParent(ctx context.Context, cancel context.CancelFunc, pid int) {
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if os.Getppid() != pid {
					cancel()
					return
				}
			}
		}
	}()
}
