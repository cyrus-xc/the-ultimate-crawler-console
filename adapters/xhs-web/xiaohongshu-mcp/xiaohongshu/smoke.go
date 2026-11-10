package xiaohongshu

import (
	"context"
	"encoding/json"
	"github.com/go-rod/rod"
)

// 兼容早期实验入口，采集逻辑只存在于 evidence.go。
func SmokeRaw(ctx context.Context, p *rod.Page, kind, id string) (json.RawMessage, error) {
	return ReadRawEvidence(ctx, p, kind, id)
}
func SmokeProfile(ctx context.Context, p *rod.Page, id, token string, target int) (map[string]any, error) {
	return ReadProfileEvidence(ctx, p, id, token, target, 0, "")
}
func SmokeDetail(ctx context.Context, p *rod.Page, id, token string, target, seconds int) (map[string]any, error) {
	return ReadDetailEvidence(ctx, p, id, token, target, seconds, "")
}
