package xiaohongshu

import "encoding/json"

// A profile lists notes newest first after its pinned cards, and a card's
// noteCard.time is the note's publish time (epoch ms). A caller that only
// needs notes published since a date may stop scrolling once the oldest
// loaded unpinned card is older than that date.
//
// The stop is trusted only while the evidence supports it: a card without a
// time, or a newer card after an older one, makes stopping unsafe. Such a
// read records the anomaly and keeps scrolling as if no date had been given.

type sinceCard struct {
	NoteCard struct {
		Time         int64 `json:"time"`
		InteractInfo struct {
			Sticky bool `json:"sticky"`
		} `json:"interactInfo"`
	} `json:"noteCard"`
}

// sinceReached reports whether loaded cards already reach past since, or why
// the order cannot be trusted ("time_missing", "order_inverted").
func sinceReached(feeds []json.RawMessage, since int64) (reached bool, anomaly string, oldest int64) {
	var previous int64
	for _, raw := range feeds {
		var card sinceCard
		if err := json.Unmarshal(raw, &card); err != nil {
			return false, "time_missing", oldest
		}
		if card.NoteCard.InteractInfo.Sticky {
			continue // pinned cards sit out of order at the top
		}
		t := card.NoteCard.Time
		if t <= 0 {
			return false, "time_missing", oldest
		}
		if previous != 0 && t > previous {
			return false, "order_inverted", oldest
		}
		previous, oldest = t, t
	}
	return oldest != 0 && oldest < since, "", oldest
}
