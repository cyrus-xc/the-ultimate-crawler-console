package xiaohongshu

import (
	"encoding/json"
	"testing"
)

func TestShareCountAliases(t *testing.T) {
	for _, test := range []struct{ name, source, want string }{
		{"detail", `{"shareCount":"70","likedCount":"188"}`, "70"},
		{"card", `{"sharedCount":"70"}`, "70"},
		{"zero", `{"shareCount":"0","sharedCount":"70"}`, "0"},
		{"numeric", `{"shareCount":7}`, "7"},
		{"rounded", `{"shareCount":"1.2万"}`, "1.2万"},
		{"missing", `{"likedCount":"1"}`, ""},
		{"empty_fallback", `{"shareCount":"","sharedCount":"6"}`, "6"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var info InteractInfo
			if err := json.Unmarshal([]byte(test.source), &info); err != nil {
				t.Fatal(err)
			}
			if info.SharedCount != test.want {
				t.Fatalf("got %q, want %q", info.SharedCount, test.want)
			}
		})
	}
}
