package crawler

import (
	"github.com/xpzouying/xiaohongshu-mcp/xiaohongshu"
	"testing"
)

func TestProfileEndObservationIsExplicitAndProfileOnly(t *testing.T) {
	valid := Request{Kind: "profile", ID: "aaaaaaaaaaaaaaaaaaaaaaaa", Target: 40, Seconds: 90, ProfileEndPolicy: xiaohongshu.ProfileEndObservationPolicy}
	if err := valid.Validate(); err != nil {
		t.Fatal(err)
	}
	ordinary := valid
	ordinary.ProfileEndPolicy = ""
	if err := ordinary.Validate(); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*Request){
		func(r *Request) { r.ProfileEndPolicy = "guess_from_no_growth" },
		func(r *Request) { r.Kind = "detail" },
		func(r *Request) { r.Kind = "search"; r.ID = ""; r.Keyword = "fixture" },
		func(r *Request) { r.ProfileWalk = true; r.WalkVersion = xiaohongshu.ProfileWalkVersion; r.Target = 0 },
		func(r *Request) { r.Since = 1 },
		func(r *Request) { r.Target = 0 },
	} {
		r := valid
		change(&r)
		if err := r.Validate(); err == nil || err.Error() != "INVALID_PROFILE_END_POLICY" {
			t.Fatalf("accepted invalid policy request: %v", err)
		}
	}
}
