package crawler

import "testing"

func TestProfileWalkRequestIsExplicitAndBoundToProfile(t *testing.T) {
	plain := Request{Kind: "profile", ID: "aaaaaaaaaaaaaaaaaaaaaaaa", Target: 0, Seconds: 45}
	if err := plain.Validate(); err != nil {
		t.Fatal(err)
	}
	walk := plain
	walk.ProfileWalk = true
	walk.WalkVersion = ProfileWalkVersion
	walk.ProfileAnchors = []string{"111111111111111111111111"}
	if err := walk.Validate(); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []Request{
		{Kind: "profile", ID: plain.ID, Target: 0, Seconds: 45, ProfileWalk: true},
		{Kind: "profile", ID: plain.ID, Target: 0, Seconds: 45, ProfileWalk: true, WalkVersion: "xhs_profile_walk_v1"},
		{Kind: "profile", ID: plain.ID, Target: 3, Seconds: 45, ProfileWalk: true},
		{Kind: "detail", ID: plain.ID, Target: 0, Seconds: 45, ProfileWalk: true},
		{Kind: "profile", ID: plain.ID, Target: 0, Seconds: 45, ProfileAnchors: walk.ProfileAnchors},
		{Kind: "profile", ID: plain.ID, Target: 0, Seconds: 45, ProfileWalk: true, ProfileSkip: []string{"not-an-id"}},
	} {
		if bad.Validate() == nil {
			t.Fatalf("accepted invalid profile walk: %#v", bad)
		}
	}
}
