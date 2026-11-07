package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/xpzouying/xiaohongshu-mcp/crawler"
	"github.com/xpzouying/xiaohongshu-mcp/xiaohongshu"
)

// An opaque decision belongs to one authenticated, still-running read. It
// cannot select another tab/note, survive cancellation, or be applied twice.
type shareDecision struct {
	noteID string
	answer chan bool
}
type shareDecisions struct {
	mu      sync.Mutex
	pending map[string]*shareDecision
}

func (s *shareDecisions) selector(w http.ResponseWriter, noteID string) xiaohongshu.ShareSelector {
	return func(ctx context.Context, raw json.RawMessage) (bool, error) {
		return s.exchange(ctx, w, "detail_ready", noteID, map[string]any{"raw": raw})
	}
}

func (s *shareDecisions) exchange(ctx context.Context, w http.ResponseWriter, phase, noteID string, data map[string]any) (bool, error) {
	var key [24]byte
	if _, err := rand.Read(key[:]); err != nil {
		return false, err
	}
	id := hex.EncodeToString(key[:])
	d := &shareDecision{noteID: noteID, answer: make(chan bool, 1)}
	s.mu.Lock()
	if s.pending == nil {
		s.pending = map[string]*shareDecision{}
	}
	s.pending[id] = d
	s.mu.Unlock()
	defer func() { s.mu.Lock(); delete(s.pending, id); s.mu.Unlock() }()
	if err := json.NewEncoder(w).Encode(map[string]any{"phase": phase, "version": crawler.Version,
		"decision_id": id, "note_id": noteID, "data": data}); err != nil {
		return false, err
	}
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	} else {
		return false, errors.New("INVALID_SHARE_SELECTION")
	}
	var deadline <-chan time.Time
	if phase != "detail_start" {
		timer := time.NewTimer(90 * time.Second)
		defer timer.Stop()
		deadline = timer.C
	}
	select {
	case wanted := <-d.answer:
		return wanted, nil
	case <-ctx.Done():
		return false, ctx.Err()
	case <-deadline:
		return false, errors.New("CRAWLER_SHARE_SELECTION_TIMEOUT")
	}
}

func (s *shareDecisions) decide(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "method", 405)
		return
	}
	var q struct {
		ID      string `json:"decision_id"`
		NoteID  string `json:"note_id"`
		Capture *bool  `json:"capture"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	dec.DisallowUnknownFields()
	if dec.Decode(&q) != nil || q.Capture == nil {
		http.Error(w, "invalid", 400)
		return
	}
	var extra any
	if dec.Decode(&extra) != io.EOF {
		http.Error(w, "invalid", 400)
		return
	}
	s.mu.Lock()
	d := s.pending[q.ID]
	if d == nil || d.noteID != q.NoteID {
		s.mu.Unlock()
		http.Error(w, "expired", 409)
		return
	}
	delete(s.pending, q.ID)
	d.answer <- *q.Capture
	s.mu.Unlock()
	_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
}
