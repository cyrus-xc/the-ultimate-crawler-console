package xiaohongshu

import (
	"encoding/json"
	"testing"
)

func TestProfileLoadingPlaceholdersDoNotSatisfyTarget(t *testing.T) {
	feeds := []json.RawMessage{
		json.RawMessage(`{"id":"","noteCard":{"noteId":"","displayTitle":"Loading"}}`),
		json.RawMessage(`{"id":"111111111111111111111111"}`),
		json.RawMessage(`{"id":"","noteCard":{"noteId":"222222222222222222222222"}}`),
		json.RawMessage(`{"id":"111111111111111111111111"}`),
	}
	if got := identifiedProfileCount(feeds); got != 2 {
		t.Fatalf("identified count = %d, want 2", got)
	}
}
