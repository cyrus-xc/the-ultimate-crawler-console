package humanize

import (
	"context"
	"testing"
	"time"
)

func TestScrollPauseRangeAndVariation(t *testing.T) {
	d := DefaultProvider{}.Timing()[BetweenScroll]
	if !d.Uniform || d.Min != 600*time.Millisecond || d.Max != 2400*time.Millisecond {
		t.Fatalf("unexpected scroll policy: %+v", d)
	}
	low, high := false, false
	for i := 0; i < 10000; i++ {
		pause := d.Sample()
		if pause < 600*time.Millisecond || pause > 2400*time.Millisecond {
			t.Fatalf("pause out of range: %s", pause)
		}
		low = low || pause < 1000*time.Millisecond
		high = high || pause > 2000*time.Millisecond
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
