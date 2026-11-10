package xiaohongshu

import (
	"context"
	_ "embed"
	"encoding/json"
	"strings"
	"time"

	"github.com/go-rod/rod"
)

const ProfileEndObservationPolicy = "observed_terminal_v1"

//go:embed profile_end_observation.js
var profileEndObservationScript string

func unavailableProfileEndObservation(reason string) map[string]any {
	return map[string]any{"schema": "xhs_profile_end_observation_v1", "terminal_decision": "unverified", "unavailable_reason": reason}
}

// observeProfileEnd never navigates, scrolls, sends network requests, or
// interprets other pages' terminal markers as the profile's end.
func observeProfileEnd(ctx context.Context, page *rod.Page, uid string) map[string]any {
	value, err := page.Context(ctx).Timeout(3*time.Second).Eval(profileEndObservationScript, uid)
	if err != nil {
		return unavailableProfileEndObservation("DOM_OBSERVATION_FAILED")
	}
	var observation map[string]any
	if json.Unmarshal([]byte(value.Value.Str()), &observation) != nil {
		return unavailableProfileEndObservation("DOM_OBSERVATION_INVALID")
	}
	return observation
}

// confirmReportedProfileEnd requires independent published metadata and the
// same profile's fully observed published cards. Scroll stagnation is not proof.
func confirmReportedProfileEnd(uid string, raw json.RawMessage, observation map[string]any) bool {
	var state struct {
		UID     string `json:"profile_user_id"`
		Profile struct {
			Posted *int `json:"posted"`
			Result struct {
				Success *bool `json:"success"`
				Code    *int  `json:"code"`
			} `json:"result"`
		} `json:"profile"`
		Active struct {
			Index *int   `json:"index"`
			Query string `json:"query"`
		} `json:"active"`
		Feeds []json.RawMessage `json:"feeds"`
	}
	if !profileNoteID.MatchString(uid) || json.Unmarshal(raw, &state) != nil || state.UID != uid ||
		state.Profile.Posted == nil || *state.Profile.Posted <= 0 || state.Profile.Result.Success == nil || !*state.Profile.Result.Success ||
		state.Profile.Result.Code == nil || *state.Profile.Result.Code != 0 || state.Active.Index == nil || *state.Active.Index != 0 || state.Active.Query != "note" {
		return false
	}
	if observation["schema"] != "xhs_profile_end_observation_v1" || observation["policy"] != ProfileEndObservationPolicy ||
		observation["profile_uid_matches"] != true || observation["unavailable_reason"] != nil {
		return false
	}
	active, ok := observation["active_tab"].(map[string]any)
	if !ok || active["index"] != float64(0) || active["query"] != "note" {
		return false
	}
	loading, ok := observation["loading_nodes"].([]any)
	if !ok || len(loading) != 0 {
		return false
	}
	flags, ok := observation["state_loading"].(map[string]any)
	if !ok {
		return false
	}
	for _, v := range flags {
		if v != false {
			return false
		}
	}
	snapshot, ok := observation["dom_snapshot"].(map[string]any)
	if !ok || snapshot["schema"] != "xhs_profile_dom_snapshot_v1" || snapshot["truncated"] != false || snapshot["unavailable_reason"] != nil {
		return false
	}
	ids := make(map[string]bool)
	for _, feed := range state.Feeds {
		var row struct {
			ID     string `json:"id"`
			NoteID string `json:"noteId"`
			Card   struct {
				NoteID string `json:"noteId"`
			} `json:"noteCard"`
		}
		if json.Unmarshal(feed, &row) != nil {
			return false
		}
		id := row.ID
		if id == "" {
			id = row.NoteID
		}
		if id == "" {
			id = row.Card.NoteID
		}
		if !profileNoteID.MatchString(id) {
			return false
		}
		ids[strings.ToLower(id)] = true
	}
	total := *state.Profile.Posted
	if len(ids) != total || observation["identified_card_count"] != float64(total) {
		return false
	}
	last, ok := observation["last_card"].(map[string]any)
	lastID, _ := last["note_id"].(string)
	if !ok || last["visible"] != true || !ids[strings.ToLower(lastID)] {
		return false
	}
	domIDs := make(map[string]bool)
	var walk func(any) bool
	walk = func(value any) bool {
		node, ok := value.(map[string]any)
		if !ok {
			return false
		}
		if node["inactive_tab"] == true {
			return true
		}
		path, _ := node["css_path"].(string)
		parts := strings.Split(path, ">")
		own := parts[len(parts)-1]
		if node["visible"] == true && (strings.Contains(own, ".feeds-loading") || node["aria_busy"] == "true" || node["role"] == "progressbar") {
			return false
		}
		if id, ok := node["note_id"].(string); ok {
			id = strings.ToLower(id)
			if !ids[id] {
				return false
			}
			domIDs[id] = true
		}
		if children, ok := node["children"].([]any); ok {
			for _, child := range children {
				if !walk(child) {
					return false
				}
			}
		}
		return true
	}
	if !walk(snapshot["tree"]) || len(domIDs) != total {
		return false
	}
	observation["terminal_decision"] = "observed"
	observation["terminal_evidence"] = map[string]any{"kind": "profile_reported_total_v1", "source": "userPageData.posted", "reported_total": total, "identified_count": len(ids), "includes_pinned": true}
	return true
}
