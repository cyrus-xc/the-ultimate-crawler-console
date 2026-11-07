package xiaohongshu

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"testing"
)

func profileCards(ids ...int) []json.RawMessage {
	rows := []json.RawMessage{}
	for _, id := range ids {
		rows = append(rows, json.RawMessage(fmt.Sprintf(`{"id":"%024x","noteCard":{"time":1000}}`, id)))
	}
	return rows
}
func TestProfileWalkStopsBeforeLaterCards(t *testing.T) {
	for _, target := range []int{1, 2} {
		calls := []string{}
		match, reason, err := visitProfileCards(context.Background(), profileCards(1, 2, 3), 0, map[string]bool{}, nil, nil, nil,
			func(nid, token string) (bool, error) {
				calls = append(calls, nid)
				return nid == fmt.Sprintf("%024x", target), nil
			})
		if err != nil || reason != "client_selected" || match != fmt.Sprintf("%024x", target) || len(calls) != target {
			t.Fatalf("match=%s reason=%s calls=%v err=%v", match, reason, calls, err)
		}
	}
}
func TestProfileWalkKnownAnchorSkippedRejectionAndCancel(t *testing.T) {
	one, two := fmt.Sprintf("%024x", 1), fmt.Sprintf("%024x", 2)
	calls := []string{}
	_, reason, err := visitProfileCards(context.Background(), profileCards(1, 2), 0, map[string]bool{}, map[string]bool{one: true}, nil, nil,
		func(nid, token string) (bool, error) { calls = append(calls, nid); return false, nil })
	if err != nil || reason != "anchor_reached" || len(calls) != 0 {
		t.Fatalf("anchor opened detail %v %v", calls, err)
	}
	_, _, err = visitProfileCards(context.Background(), profileCards(1, 2), 0, map[string]bool{}, nil, map[string]bool{one: true}, nil,
		func(nid, token string) (bool, error) { calls = append(calls, nid); return false, nil })
	if err != nil || !reflect.DeepEqual(calls, []string{two}) {
		t.Fatalf("skip stopped rather than continuing: %v", calls)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, _, err = visitProfileCards(ctx, profileCards(1), 0, map[string]bool{}, nil, nil, nil, func(string, string) (bool, error) { t.Fatal("cancelled walk read a card"); return false, nil })
	if err != context.Canceled {
		t.Fatal(err)
	}
}

func TestProfileWalkPinnedAnchorDoesNotHideNewerUnpinnedCards(t *testing.T) {
	one := fmt.Sprintf("%024x", 1)
	rows := profileCards(1, 2, 3)
	rows[0] = json.RawMessage(fmt.Sprintf(`{"id":"%s","noteCard":{"time":1000,"interactInfo":{"sticky":true}}}`, one))
	calls := []string{}
	match, reason, err := visitProfileCards(context.Background(), rows, 0, map[string]bool{}, map[string]bool{one: true}, map[string]bool{one: true}, nil,
		func(nid, token string) (bool, error) { calls = append(calls, nid); return true, nil })
	if err != nil || reason != "client_selected" || match != fmt.Sprintf("%024x", 2) || len(calls) != 1 {
		t.Fatalf("pinned anchor hid new posts: %v %v %v", match, calls, err)
	}
	seen := map[string]bool{}
	calls = nil
	visit := func(nid, token string) (bool, error) { calls = append(calls, nid); return false, nil }
	if _, _, err := visitProfileCards(context.Background(), profileCards(1, 2), 2000, seen, nil, nil, nil, visit); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 0 {
		t.Fatal("visited known older cards")
	}
}

func TestProfileWalkAdmissionRunsBeforeHydrationAndCanStopNextCard(t *testing.T) {
	for _, failAt := range []int{0, 2} {
		admitted, hydrated := []string{}, []string{}
		_, _, err := visitProfileCards(context.Background(), profileCards(1, 2, 3), 0, map[string]bool{}, nil, nil,
			func(nid string) error {
				admitted = append(admitted, nid)
				if len(admitted) == failAt {
					return context.Canceled
				}
				return nil
			}, func(nid, token string) (bool, error) { hydrated = append(hydrated, nid); return false, nil })
		if failAt == 0 && (err != nil || len(admitted) != 3 || len(hydrated) != 3) {
			t.Fatalf("all admissions=%v hydrated=%v err=%v", admitted, hydrated, err)
		}
		if failAt == 2 && (err != context.Canceled || len(admitted) != 2 || len(hydrated) != 1) {
			t.Fatalf("blocked admission hydrated next detail: %v %v %v", admitted, hydrated, err)
		}
	}
}
