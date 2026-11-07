package xiaohongshu

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestCancelledSelectionStillClosesTheSameNote(t *testing.T) {
	p, _ := navigationFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	ctx = WithShareSelector(ctx, func(context.Context, json.RawMessage) (bool, error) {
		cancel()
		return false, context.Canceled
	})
	_, err := ReadDetailEvidence(ctx, p, fmt.Sprintf("%024x", 1), "fixture", -1, 1, strings.Repeat("1", 24))
	if !errors.Is(err, context.Canceled) || p.MustEval(`() => window.noteCloseCount`).Int() != 1 {
		t.Fatal("a stopped decision did not close its own note")
	}
}

func TestSelectiveShareDecidesBeforeXAndDoesNotReopen(t *testing.T) {
	p, loads := navigationFixture(t)
	p.MustEval(`() => {window.copyClicks=0;document.addEventListener('click',e=>{if(e.target.textContent==='复制链接')window.copyClicks++},true)}`)
	for _, q := range []struct {
		index    int
		selected bool
	}{{20, false}, {21, true}, {22, false}} {
		calls := 0
		ctx := WithShareSelector(context.Background(), func(ctx context.Context, raw json.RawMessage) (bool, error) {
			calls++
			var state struct {
				Note struct {
					Desc string `json:"desc"`
				} `json:"note"`
			}
			json.Unmarshal(raw, &state)
			if state.Note.Desc == "" || !p.MustEval(`() => document.querySelector('.note-detail-mask').style.display==='block'`).Bool() {
				t.Fatal("decision preceded body or followed X")
			}
			return q.selected, nil
		})
		data, err := ReadDetailEvidence(ctx, p, fmt.Sprintf("%024x", q.index), "fixture", -1, 1, strings.Repeat("1", 24))
		if err != nil {
			t.Fatal(err)
		}
		status := "not_requested"
		if q.selected {
			status = "captured"
		}
		if calls != 1 || data["share_status"] != status {
			t.Fatalf("unexpected decision/copy: calls=%d status=%v", calls, data["share_status"])
		}
		if loads.Load() != 1 || p.MustEval(`() => document.querySelector('.note-detail-mask').style.display==='block'`).Bool() {
			t.Fatal("selection reloaded list or left overlay open")
		}
	}
	if p.MustEval(`() => window.copyClicks`).Int() != 1 || p.MustEval(`() => window.noteCloseCount`).Int() != 3 {
		t.Fatal("unselected notes copied, or a selected note reopened")
	}
}

func TestLowLevelDetailNeverCopiesWithoutSelection(t *testing.T) {
	p, _ := navigationFixture(t)
	data, err := ReadDetailEvidence(context.Background(), p, fmt.Sprintf("%024x", 1), "fixture", -1, 1, strings.Repeat("1", 24))
	if err != nil || data["share_status"] != "not_requested" {
		t.Fatal("plain evidence read attempted a share")
	}
}
