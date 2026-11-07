package xiaohongshu

import (
	"encoding/json"
	"fmt"
	"testing"
)

func cards(spec ...string) []json.RawMessage {
	out := make([]json.RawMessage, 0, len(spec))
	for _, s := range spec {
		out = append(out, json.RawMessage(s))
	}
	return out
}

func card(t int64, sticky bool) string {
	return fmt.Sprintf(`{"id":"x","noteCard":{"time":%d,"interactInfo":{"sticky":%t}}}`, t, sticky)
}

func TestSinceReachedStopsAtFirstOlderUnpinnedCard(t *testing.T) {
	feeds := cards(card(100, true), card(900, false), card(500, false), card(300, false))
	if reached, anomaly, oldest := sinceReached(feeds, 400); !reached || anomaly != "" || oldest != 300 {
		t.Fatalf("got %v %q %d", reached, anomaly, oldest)
	}
	if reached, _, _ := sinceReached(feeds, 200); reached {
		t.Fatal("stopped before reaching since")
	}
}

func TestSinceReachedIgnoresOldPinnedCards(t *testing.T) {
	// A pinned note from years ago must not end the scan.
	if reached, anomaly, _ := sinceReached(cards(card(1, true), card(900, false)), 400); reached || anomaly != "" {
		t.Fatalf("pinned card stopped the scan: %v %q", reached, anomaly)
	}
}

func TestSinceReachedRefusesToStopOnMissingTime(t *testing.T) {
	feeds := cards(card(900, false), `{"id":"x","noteCard":{}}`, card(100, false))
	if reached, anomaly, _ := sinceReached(feeds, 400); reached || anomaly != "time_missing" {
		t.Fatalf("got %v %q", reached, anomaly)
	}
}

func TestSinceReachedRefusesToStopOnInvertedOrder(t *testing.T) {
	feeds := cards(card(900, false), card(100, false), card(800, false))
	if reached, anomaly, _ := sinceReached(feeds, 400); reached || anomaly != "order_inverted" {
		t.Fatalf("got %v %q", reached, anomaly)
	}
}
