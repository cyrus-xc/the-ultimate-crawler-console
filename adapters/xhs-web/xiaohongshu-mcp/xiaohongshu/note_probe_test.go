package xiaohongshu

import (
	"encoding/json"
	"testing"
)

func TestGonePathClassification(t *testing.T) {
	gone := []string{"/other", "/other/abc", "/404", "/not-found"}
	for _, path := range gone {
		if !isGonePath(path) {
			t.Fatalf("expected gone: %q", path)
		}
	}
	alive := []string{"/explore/6aa93260000000002b01cfe3", "/user/profile/5f8c574500000000010085bc", "/search_result/", "/", "/login"}
	for _, path := range alive {
		if isGonePath(path) {
			t.Fatalf("false positive gone: %q", path)
		}
	}
}

func TestCardPreviewIsNotAcceptedAsDetail(t *testing.T) {
	preview := json.RawMessage(`{"comments":{},"note":{"imageList":[],"noteId":"a","title":"t","type":"normal","user":{"userId":"u"},"xsecToken":"x"}}`)
	if hasDetailFields(preview) {
		t.Fatal("card preview accepted as a detail payload")
	}
	for _, detail := range []string{
		`{"note":{"noteId":"a","user":{"userId":"u"},"desc":""}}`,
		`{"note":{"noteId":"a","user":{"userId":"u"},"time":1}}`,
		`{"note":{"noteId":"a","user":{"userId":"u"},"interactInfo":{}}}`,
	} {
		if !hasDetailFields(json.RawMessage(detail)) {
			t.Fatalf("detail payload rejected: %s", detail)
		}
	}
}
