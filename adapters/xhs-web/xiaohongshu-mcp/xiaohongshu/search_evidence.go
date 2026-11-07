package xiaohongshu

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/go-rod/rod"
	"github.com/xpzouying/xiaohongshu-mcp/humanize"
	"time"
)

// ReadSearchEvidence 复用搜索导航；保留原卡片和令牌，使用调用方的采集预算。
func ReadSearchEvidence(ctx context.Context, page *rod.Page, keyword string, target int) (map[string]any, error) {
	return ReadSearchEvidenceWithBudget(ctx, page, keyword, target, 45, "")
}

func ReadSearchEvidenceWithBudget(ctx context.Context, page *rod.Page, keyword string, target, seconds int, sortBy string) (map[string]any, error) {
	if _, err := NewSearchAction(page).Search(ctx, keyword, FilterOption{SortBy: sortBy}); err != nil {
		return nil, err
	}
	deadline := time.Now().Add(time.Duration(seconds) * time.Second)
	counts := []int{}
	last := -1
	stalled := 0
	lastGrowth := time.Now()
	stop := "scroll_limit"
	var raw json.RawMessage
	accumulated := []json.RawMessage{}
	allSeen := map[string]bool{}
	endObserved := false
	for {
		var err error
		raw, err = ReadRawEvidence(ctx, page.Context(ctx), "search", "")
		if err != nil {
			return nil, err
		}
		var state struct {
			Feeds []json.RawMessage `json:"feeds"`
		}
		if err = json.Unmarshal(raw, &state); err != nil {
			return nil, err
		}
		for _, item := range state.Feeds {
			var f struct {
				ID        string `json:"id"`
				ModelType string `json:"modelType"`
			}
			if json.Unmarshal(item, &f) == nil && len(f.ID) == 24 && (f.ModelType == "" || f.ModelType == "note") && !allSeen[f.ID] {
				allSeen[f.ID] = true
				accumulated = append(accumulated, item)
			}
		}
		n := len(accumulated)
		counts = append(counts, n)
		terminal, checkErr := page.Context(ctx).Eval(`() => {const h=window.__INITIAL_STATE__?.search?.hasMore;const v=h?.value??h?._value??h;return v===false;}`)
		// A false initial flag on an empty/auth page is not proof of an empty result.
		if checkErr == nil && terminal.Value.Bool() && n > 0 && n == last {
			endObserved = true
			stop = "search_end_observed"
			break
		}
		if target > 0 && n >= target {
			stop = "target_loaded"
			break
		}
		if n == 0 {
			// An auth overlay can leave an initialized but empty search array.
			// Never cache that as a successful search with no matching notes.
			state, checkErr := page.Context(ctx).Eval(`() => document.body?.innerText.includes("电脑设备登录超限") || false`)
			if checkErr != nil {
				return nil, checkErr
			}
			if state.Value.Bool() {
				return nil, fmt.Errorf("CRAWLER_RELOGIN_REQUIRED")
			}
		}
		if n == last {
			stalled++
		} else {
			stalled = 0
			lastGrowth = time.Now()
		}
		last = n
		if scrollStalled(stalled, time.Since(lastGrowth)) {
			stop = "no_growth"
			if n == 0 {
				stop = "unconfirmed_empty"
			}
			break
		}
		if seconds > 0 && time.Now().After(deadline) {
			stop = "time_budget"
			break
		}
		if err = page.Context(ctx).Mouse.Scroll(0, 850, 1); err != nil {
			return nil, err
		}
		humanize.Delay(ctx, humanize.BetweenScroll)
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
	}
	raw, _ = json.Marshal(map[string]any{"feeds": accumulated})
	return map[string]any{"raw": raw, "keyword": keyword, "requested": target, "sort_by": sortBy, "loaded_counts": counts, "stop_reason": stop, "end_observed": endObserved, "search_contract": "web_observed_routes_v2"}, nil
}
