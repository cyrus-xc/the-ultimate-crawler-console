package xiaohongshu

import (
	"encoding/json"
	"testing"
)

func TestLazyLoadRequiresEveryReplyPageAndKnownRootEnd(t *testing.T) {
	for _, raw := range []string{
		`{}`, `{ "comments":{"firstRequestFinish":true,"list":[]} }`,
		`{"comments":{"firstRequestFinish":true,"hasMore":true,"list":[]}}`,
		`{"comments":{"firstRequestFinish":true,"hasMore":false,"loading":true,"list":[]}}`,
		`{"comments":{"firstRequestFinish":true,"hasMore":false,"list":[{"id":"a","subCommentCount":"2","subCommentHasMore":true,"subComments":[{"id":"b"}]}]}}`,
		`{"comments":{"firstRequestFinish":true,"hasMore":false,"list":[{"id":"a","subCommentCount":"2","subCommentHasMore":false,"subComments":[{"id":"b"},{"id":"b"}]}]}}`,
		`{"comments":{"firstRequestFinish":true,"hasMore":false,"list":[{"id":"a"}]}}`,
		`{"comments":{"firstRequestFinish":true,"hasMore":false,"list":[{"id":"a","subCommentCount":"1","expended":true,"hasMore":true,"subCommentHasMore":false,"subComments":[{"id":"b"}]}]}}`,
		`{"comments":{"firstRequestFinish":true,"hasMore":false,"list":[{"id":"a","subCommentCount":"1","expended":true,"subCommentHasMore":false,"subComments":[{"id":"b"}]}]}}`,
	} {
		if commentsFullyObserved(json.RawMessage(raw)) {
			t.Fatal("incomplete state accepted", raw)
		}
	}
	for _, raw := range []string{
		`{"comments":{"firstRequestFinish":true,"hasMore":false,"list":[]}}`,
		`{"comments":{"firstRequestFinish":true,"hasMore":false,"list":[{"id":"a","subCommentCount":"2","expended":true,"hasMore":false,"subCommentHasMore":true,"subComments":[{"id":"b"},{"id":"c"}]}]}}`,
		`{"comments":{"firstRequestFinish":true,"hasMore":false,"list":[{"id":"a","subCommentCount":"2","subCommentHasMore":false,"subComments":[{"id":"b"},{"id":"c"}]},{"id":"d","subCommentCount":0}]}}`,
	} {
		if !commentsFullyObserved(json.RawMessage(raw)) {
			t.Fatal("complete state rejected", raw)
		}
	}
	loader := commentLoader{config: (CommentLoadConfig{LazyLoadOnScroll: true, MaxCommentItems: 1, MaxRepliesThreshold: 100}).normalize(), stats: &loadStats{}, state: &loadState{}}
	if loader.shouldStopAtTarget(200) || loader.config.MaxRepliesThreshold != 0 || !loader.shouldClickButtons() || loader.config.LazyLoadLimit != defaultLazyLoadLimit {
		t.Fatal("limited_lazy_load_on_scroll retained sample ceiling")
	}
}

// LazyLoadLimit 为 0 时回落到默认两页，显式值不被覆盖。
func TestCommentLoadConfigLazyLoadLimitDefault(t *testing.T) {
	got := CommentLoadConfig{LazyLoadOnScroll: true}.normalize()
	if got.LazyLoadLimit != defaultLazyLoadLimit {
		t.Fatalf("default lazy limit = %d, want %d", got.LazyLoadLimit, defaultLazyLoadLimit)
	}
	got = CommentLoadConfig{LazyLoadOnScroll: true, LazyLoadLimit: 5}.normalize()
	if got.LazyLoadLimit != 5 {
		t.Fatalf("explicit lazy limit overwritten: %d", got.LazyLoadLimit)
	}
}

func TestCommentsReadinessDoesNotConfuseSSRPlaceholderWithEmptyResult(t *testing.T) {
	for _, raw := range []string{`{}`, `{"comments":{"list":[],"hasMore":true,"firstRequestFinish":false}}`, `broken`} {
		if commentsReady(json.RawMessage(raw)) {
			t.Fatal("placeholder accepted as loaded", raw)
		}
	}
	for _, raw := range []string{`{"comments":{"list":[],"firstRequestFinish":true}}`, `{"comments":{"list":[{"id":"c"}]}}`} {
		if !commentsReady(json.RawMessage(raw)) {
			t.Fatal("loaded state rejected", raw)
		}
	}
}

func TestCommentSampleStopsAtUniqueParentTargetWithoutClaimingAllReplies(t *testing.T) {
	raw := json.RawMessage(`{"note":{"interactInfo":{"commentCount":"100"}},"comments":{"list":[{"id":"a"},{"id":"a"},{"id":"b"}]}}`)
	if got := commentSampleStop(raw, 2); got != "parent_target_observed" {
		t.Fatal(got)
	}
	if got := commentSampleStop(raw, 3); got != "" {
		t.Fatal("duplicate parents counted", got)
	}
	if got := commentSampleStop(json.RawMessage(`{"note":{"interactInfo":{"commentCount":"1"}},"comments":{"list":[{"id":"a"}]}}`), 10); got != "reported_count_observed" {
		t.Fatal(got)
	}
	if got := commentSampleStop(json.RawMessage(`{"comments":{"list":[]}}`), 10); got != "" {
		t.Fatal("empty placeholder accepted")
	}
}
