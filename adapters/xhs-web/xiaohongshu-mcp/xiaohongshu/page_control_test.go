package xiaohongshu

import (
	"context"
	"encoding/json"
	"testing"
)

func TestPageControlPreservesSnapshotAndStop(t *testing.T) {
	called := 0
	raw := json.RawMessage(`{"feeds":[{"id":"observed"}]}`)
	ctx := WithPageControl(context.Background(), PageControl{Limit: 2, Observe: func(_ context.Context, value json.RawMessage) (bool, error) {
		called++
		if string(value) != string(raw) {
			t.Fatal("raw changed")
		}
		return false, nil
	}})
	keep, err := observePage(ctx, raw)
	if keep || err != nil || called != 1 {
		t.Fatal("stop not preserved")
	}
	if pageLimitReached(ctx, 1) || !pageLimitReached(ctx, 2) {
		t.Fatal("page bound")
	}
	if pageLimitReached(context.Background(), 100) {
		t.Fatal("legacy became bounded")
	}
}
