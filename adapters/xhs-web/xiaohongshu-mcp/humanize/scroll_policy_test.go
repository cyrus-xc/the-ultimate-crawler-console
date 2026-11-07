package humanize

import (
	"context"
	"testing"
	"time"
)

func TestScrollPauseRangeAndVariation(t *testing.T) {
	d := DefaultProvider{}.Timing()[BetweenScroll]
	if !d.Uniform || d.Min != 0 || d.Max != 2*time.Second {
		t.Fatalf("unexpected scroll policy: %+v", d)
	}
	low, high := false, false
	for i := 0; i < 10000; i++ {
		pause := d.Sample()
		if pause < 0 || pause > 2*time.Second {
			t.Fatalf("pause out of range: %s", pause)
		}
		low = low || pause < 500*time.Millisecond
		high = high || pause > 1500*time.Millisecond
	}
	if !low || !high {
		t.Fatal("scroll pause lacks variation across the requested range")
	}
}

func TestScrollPauseCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	started := time.Now()
	Delay(ctx, BetweenScroll)
	if time.Since(started) > 100*time.Millisecond {
		t.Fatal("cancelled scroll delay blocked shutdown")
	}
}
