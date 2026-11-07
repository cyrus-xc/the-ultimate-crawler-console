package xiaohongshu

import (
	"context"
	"encoding/json"
)

type pageControlKey struct{}
type PageControl struct {
	Limit   int
	Observe func(context.Context, json.RawMessage) (bool, error)
}

func WithPageControl(ctx context.Context, control PageControl) context.Context {
	return context.WithValue(ctx, pageControlKey{}, control)
}
func observePage(ctx context.Context, raw json.RawMessage) (bool, error) {
	control, ok := ctx.Value(pageControlKey{}).(PageControl)
	if !ok || control.Observe == nil {
		return true, nil
	}
	return control.Observe(ctx, raw)
}
func pageLimitReached(ctx context.Context, count int) bool {
	control, ok := ctx.Value(pageControlKey{}).(PageControl)
	return ok && control.Limit > 0 && count >= control.Limit
}
