package xiaohongshu

import (
	"encoding/json"
	"fmt"
	"os"
	"testing"
)

func reportedFixture(t *testing.T) (string, json.RawMessage, map[string]any) {
	t.Helper()
	data, err := os.ReadFile("../../../../test/fixtures/profile-reported-total-19.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		UID         string          `json:"uid"`
		Raw         json.RawMessage `json:"raw"`
		Observation map[string]any  `json:"observation"`
	}
	if err = json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture.UID, fixture.Raw, fixture.Observation
}

func TestReportedProfileTotalFixtureReplay(t *testing.T) {
	uid, raw, obs := reportedFixture(t)
	end := confirmReportedProfileEnd(uid, raw, obs)
	if !end {
		t.Fatal("same-capture independent published total and observed cards must establish end")
	}
	data, _ := json.Marshal(map[string]any{"raw": raw, "end_observed": end, "stop_reason": "no_growth", "profile_end_observation": obs})
	fmt.Printf("PROFILE_END_REPLAY=%s\n", data)
}

func TestReportedProfileTotalRejectsUnprovenEnd(t *testing.T) {
	cases := []struct {
		name   string
		change func(map[string]any, map[string]any)
	}{
		{"wrong_uid", func(r, o map[string]any) { r["profile_user_id"] = "000000000000000000000001" }},
		{"failed_profile", func(r, o map[string]any) { r["profile"].(map[string]any)["result"].(map[string]any)["success"] = false }},
		{"error_code", func(r, o map[string]any) { r["profile"].(map[string]any)["result"].(map[string]any)["code"] = 1 }},
		{"null_code", func(r, o map[string]any) { r["profile"].(map[string]any)["result"].(map[string]any)["code"] = nil }},
		{"string_code", func(r, o map[string]any) { r["profile"].(map[string]any)["result"].(map[string]any)["code"] = "0" }},
		{"string_total", func(r, o map[string]any) { r["profile"].(map[string]any)["posted"] = "19" }},
		{"formatted_total", func(r, o map[string]any) { r["profile"].(map[string]any)["posted"] = "1.9万" }},
		{"zero_total", func(r, o map[string]any) { r["profile"].(map[string]any)["posted"] = 0 }},
		{"negative_total", func(r, o map[string]any) { r["profile"].(map[string]any)["posted"] = -1 }},
		{"null_total", func(r, o map[string]any) { r["profile"].(map[string]any)["posted"] = nil }},
		{"missing_total", func(r, o map[string]any) { delete(r["profile"].(map[string]any), "posted") }},
		{"fractional_total", func(r, o map[string]any) { r["profile"].(map[string]any)["posted"] = 19.5 }},
		{"boolean_total", func(r, o map[string]any) { r["profile"].(map[string]any)["posted"] = true }},
		{"total_mismatch", func(r, o map[string]any) { r["profile"].(map[string]any)["posted"] = 20 }},
		{"duplicate_inflation", func(r, o map[string]any) { f := r["feeds"].([]any); f[18] = f[0] }},
		{"wrong_raw_tab", func(r, o map[string]any) { r["active"].(map[string]any)["query"] = "collect" }},
		{"wrong_dom_tab", func(r, o map[string]any) { o["active_tab"].(map[string]any)["index"] = 1 }},
		{"wrong_observed_uid", func(r, o map[string]any) { o["profile_uid_matches"] = false }},
		{"loading", func(r, o map[string]any) { o["state_loading"].(map[string]any)["loading"] = true }},
		{"visible_loading_node", func(r, o map[string]any) { o["loading_nodes"] = []any{map[string]any{"visible": true}} }},
		{"truncated", func(r, o map[string]any) { o["dom_snapshot"].(map[string]any)["truncated"] = true }},
		{"no_dom", func(r, o map[string]any) { delete(o, "dom_snapshot") }},
		{"invisible_last", func(r, o map[string]any) { o["last_card"].(map[string]any)["visible"] = false }},
		{"wrong_last_id", func(r, o map[string]any) { o["last_card"].(map[string]any)["note_id"] = "000000000000000000000001" }},
		{"unavailable", func(r, o map[string]any) { o["unavailable_reason"] = "READ_STOPPED" }},
		{"wrong_policy", func(r, o map[string]any) { o["policy"] = "other" }},
		{"unobserved_dom_cards", func(r, o map[string]any) {
			o["dom_snapshot"].(map[string]any)["tree"] = map[string]any{"visible": true}
		}},
		{"visible_profile_spinner", func(r, o map[string]any) {
			tree := o["dom_snapshot"].(map[string]any)["tree"].(map[string]any)
			tree["children"] = append(tree["children"].([]any), map[string]any{"visible": true, "css_path": "div.feeds-loading"})
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			uid, raw, o := reportedFixture(t)
			var r map[string]any
			json.Unmarshal(raw, &r)
			tc.change(r, o)
			raw, _ = json.Marshal(r)
			if confirmReportedProfileEnd(uid, raw, o) {
				t.Fatal("unproven end accepted")
			}
			if o["terminal_decision"] != "unverified" {
				t.Fatal("rejection changed observation")
			}
		})
	}
}

func TestReportedProfileTotalIncludesPinsAndDeduplicates(t *testing.T) {
	uid, raw, o := reportedFixture(t)
	var r map[string]any
	json.Unmarshal(raw, &r)
	feeds := r["feeds"].([]any)
	feeds[0].(map[string]any)["noteCard"].(map[string]any)["interactInfo"].(map[string]any)["sticky"] = true
	r["feeds"] = append(feeds, feeds[0])
	raw, _ = json.Marshal(r)
	if !confirmReportedProfileEnd(uid, raw, o) {
		t.Fatal("pins are part of independent published total; overlaps must not inflate it")
	}
}
