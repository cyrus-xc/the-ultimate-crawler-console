package xiaohongshu

import (
	"testing"
	"time"
)

func TestScrollStallAllowsAsyncLoading(t *testing.T) {
	if scrollStalled(3, 100*time.Millisecond) || scrollStalled(2, 10*time.Second) {
		t.Fatal("short random pauses must not prematurely stop discovery")
	}
	if !scrollStalled(3, 4500*time.Millisecond) {
		t.Fatal("stable stalled page should stop as partial evidence")
	}
}
