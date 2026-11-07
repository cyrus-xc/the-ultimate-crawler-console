package xiaohongshu

import (
	"context"
	"encoding/json"
)

const ShareSelectionVersion = "xhs_selective_share_v1"

// The caller owns relevance. The browser only asks once, while this note's
// identity tab is held, then optionally copies and closes through the same X.
type ShareSelector func(context.Context, json.RawMessage) (bool, error)
type shareSelectorKey struct{}

func WithShareSelector(ctx context.Context, selector ShareSelector) context.Context {
	return context.WithValue(ctx, shareSelectorKey{}, selector)
}

func HasShareSelector(ctx context.Context) bool {
	selector, _ := ctx.Value(shareSelectorKey{}).(ShareSelector)
	return selector != nil
}

func selectShare(ctx context.Context, raw json.RawMessage) (bool, error) {
	selector, _ := ctx.Value(shareSelectorKey{}).(ShareSelector)
	if selector == nil {
		return false, nil
	}
	return selector(ctx, raw)
}
