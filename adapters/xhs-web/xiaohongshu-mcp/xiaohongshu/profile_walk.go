package xiaohongshu

import (
	"context"
	"encoding/json"
)

const ProfileWalkVersion = "xhs_profile_walk_v2"

// Relevance belongs to the caller. Observe checkpoints a completed detail
// after its overlay has closed, before another card or scroll is attempted.
type ProfileWalk struct {
	Anchors map[string]bool
	Skip    map[string]bool
	Before  func(context.Context, string) error
	Select  func(context.Context, string, string, json.RawMessage) (bool, error)
	Observe func(context.Context, string, map[string]any) (bool, error)
}
type profileWalkKey struct{}

func WithProfileWalk(ctx context.Context, walk ProfileWalk) context.Context {
	return context.WithValue(ctx, profileWalkKey{}, walk)
}
func profileWalk(ctx context.Context) (ProfileWalk, bool) {
	walk, ok := ctx.Value(profileWalkKey{}).(ProfileWalk)
	return walk, ok && walk.Before != nil && walk.Select != nil && walk.Observe != nil
}
func HasProfileWalk(ctx context.Context) bool { _, ok := profileWalk(ctx); return ok }

func visitProfileCards(ctx context.Context, feeds []json.RawMessage, since int64, seen, anchors, skip map[string]bool,
	before func(string) error, visit func(string, string) (bool, error)) (string, string, error) {
	for _, raw := range feeds {
		if err := ctx.Err(); err != nil {
			return "", "", err
		}
		var card struct {
			ID     string `json:"id"`
			NoteID string `json:"noteId"`
			Token  string `json:"xsecToken"`
			Card   struct {
				ID       string `json:"noteId"`
				Token    string `json:"xsecToken"`
				Time     int64  `json:"time"`
				Interact struct {
					Sticky bool `json:"sticky"`
				} `json:"interactInfo"`
			} `json:"noteCard"`
		}
		if err := json.Unmarshal(raw, &card); err != nil {
			return "", "", err
		}
		nid := card.ID
		if nid == "" {
			nid = card.NoteID
		}
		if nid == "" {
			nid = card.Card.ID
		}
		if !profileNoteID.MatchString(nid) || seen[nid] {
			continue
		}
		seen[nid] = true
		if since > 0 && card.Card.Time > 0 && card.Card.Time < since {
			continue
		}
		if anchors[nid] && !card.Card.Interact.Sticky {
			return nid, "anchor_reached", nil
		}
		if skip[nid] {
			continue
		}
		if before != nil {
			if err := before(nid); err != nil {
				return "", "", err
			}
		}
		token := card.Token
		if token == "" {
			token = card.Card.Token
		}
		selected, err := visit(nid, token)
		if err != nil {
			return "", "", err
		}
		if selected {
			return nid, "client_selected", nil
		}
	}
	return "", "", nil
}
