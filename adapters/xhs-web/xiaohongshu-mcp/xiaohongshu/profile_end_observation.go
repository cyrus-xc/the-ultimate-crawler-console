package xiaohongshu

import (
	"context"
	_ "embed"
	"encoding/json"
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
