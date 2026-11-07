package xiaohongshu

import (
	"encoding/json"
	"testing"
)

func TestObservedReportedComments(t *testing.T) {
	for _, test := range []struct {
		raw      string
		complete bool
	}{
		{`{"note":{"interactInfo":{"commentCount":"2"}},"comments":{"list":[{"id":"a","subComments":[{"id":"b"}]}]}}`, true},
		{`{"note":{"interactInfo":{"commentCount":"3"}},"comments":{"list":[{"id":"a","subComments":[{"id":"b"}]}]}}`, false},
		{`{"note":{"interactInfo":{"commentCount":"2"}},"comments":{"list":[{"id":"a"},{"id":"a"}]}}`, false},
		{`{"note":{"interactInfo":{"commentCount":"1万"}}}`, false},
		{`{"note":{"interactInfo":{}}}`, false},
	} {
		if got := observedReportedComments(json.RawMessage(test.raw)); got != test.complete {
			t.Errorf("got %v, want %v", got, test.complete)
		}
	}
}
