package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestShareDecisionIsBoundToReadAndNote(t *testing.T) {
	s := &shareDecisions{pending: map[string]*shareDecision{"opaque": {noteID: "note", answer: make(chan bool, 1)}}}
	post := func(note string) int {
		w := httptest.NewRecorder()
		r := httptest.NewRequest("POST", "/share-decision", strings.NewReader(`{"decision_id":"opaque","note_id":"`+note+`","capture":true}`))
		s.decide(w, r)
		return w.Code
	}
	if post("other") != 409 || post("note") != 200 || post("note") != 409 {
		t.Fatal("cross-note or repeated decision accepted")
	}
}

func TestCancelledShareSelectionRemovesPendingDecision(t *testing.T) {
	s := &shareDecisions{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	w := httptest.NewRecorder()
	_, err := s.selector(w, "note")(ctx, json.RawMessage(`{"note":{"desc":"body"}}`))
	if err == nil || len(s.pending) != 0 || !bytes.Contains(w.Body.Bytes(), []byte("detail_ready")) {
		t.Fatal("cancelled selection leaked its read")
	}
}
