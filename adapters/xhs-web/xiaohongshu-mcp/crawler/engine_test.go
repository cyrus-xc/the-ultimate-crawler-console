package crawler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"testing"

	"github.com/xpzouying/xiaohongshu-mcp/xiaohongshu"
)

func TestReadContractRejectsUnsafeOrUnboundedRequests(t *testing.T) {
	valid := Request{Kind: "profile", ID: "5f8c574500000000010085bc", Target: 24, Seconds: 45}
	if err := valid.Validate(); err != nil {
		t.Fatal(err)
	}
	cases := []Request{
		{Kind: "publish", ID: valid.ID, Target: 24, Seconds: 45},
		{Kind: "profile", ID: "https://example.com", Target: 24, Seconds: 45},
		{Kind: "profile", ID: valid.ID, Target: 101, Seconds: 45},
		{Kind: "detail", ID: valid.ID, Target: 5, Seconds: 91},
		{Kind: "profile", ID: valid.ID, Target: 24, Seconds: 45, Comments: true},
		{Kind: "search", Keyword: " ", Target: 5, Seconds: 45},
	}
	for _, r := range cases {
		if _, err := New().Read(context.Background(), r); err == nil {
			t.Fatalf("accepted invalid request: %+v", r)
		}
	}
	if err := (Request{Kind: "search", Keyword: "咖啡", Target: 5, Seconds: 10}).Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestPublicErrorsDoNotExposeURLs(t *testing.T) {
	if got := ErrorCode(errors.New("CRAWLER_RELOGIN_REQUIRED")); got != "CRAWLER_RELOGIN_REQUIRED" {
		t.Fatal(got)
	}
	if got := ErrorCode(errors.New("https://example.com/?xsec_token=private")); got != "CRAWLER_ACCESS_UNAVAILABLE" {
		t.Fatal(got)
	}
	if got := ErrorCode(context.DeadlineExceeded); got != "CRAWLER_TIMEOUT" {
		t.Fatal(got)
	}
}

// A page that never loaded is a network-path problem, not an XHS access
// decision; it must not read as "check for an access restriction".
func TestNetworkFailuresAreNotReportedAsAccessProblems(t *testing.T) {
	for _, msg := range []string{"navigation failed: net::ERR_CONNECTION_CLOSED", "navigation failed: net::ERR_PROXY_CONNECTION_FAILED",
		"net::ERR_NAME_NOT_RESOLVED at https://www.xiaohongshu.com/?xsec_token=private"} {
		if got := ErrorCode(errors.New(msg)); got != "CRAWLER_NETWORK_UNAVAILABLE" {
			t.Fatalf("%q -> %s", msg, got)
		}
	}
	// Navigation aborted by the page itself is not a connectivity failure.
	if got := ErrorCode(errors.New("navigation failed: net::ERR_ABORTED")); got != "CRAWLER_ACCESS_UNAVAILABLE" {
		t.Fatal(got)
	}
	// A typed platform code still wins over a network-looking message.
	if got := ErrorCode(errors.New("CRAWLER_RATE_LIMITED after net::ERR_CONNECTION_RESET")); got != "CRAWLER_RATE_LIMITED" {
		t.Fatal(got)
	}
}

// A page wrapper prefixes its own code ("PROFILE_STATE_UNAVAILABLE: ..."). The
// embedded platform classification must still win, or an expired login is
// reported as an unknown access failure and the operator is sent to the wrong fix.
func TestTypedAccessCodeBeatsGenericWrapper(t *testing.T) {
	wrapped := fmt.Errorf("PROFILE_STATE_UNAVAILABLE: %w", &xiaohongshu.AccessError{Code: "CRAWLER_RELOGIN_REQUIRED"})
	if got := ErrorCode(wrapped); got != "CRAWLER_RELOGIN_REQUIRED" {
		t.Fatalf("masked platform code: got %q", got)
	}
	restricted := fmt.Errorf("SEARCH_STATE_UNAVAILABLE: %w", &xiaohongshu.AccessError{Code: "CRAWLER_ACCESS_RESTRICTED"})
	if got := ErrorCode(restricted); got != "CRAWLER_ACCESS_RESTRICTED" {
		t.Fatalf("masked platform code: got %q", got)
	}
	// A wrapped rate limit must not be mistaken for an access restriction.
	rate := fmt.Errorf("NOTE_STATE_UNAVAILABLE: %w", &xiaohongshu.AccessError{Code: "CRAWLER_RATE_LIMITED"})
	if got := ErrorCode(rate); got != "CRAWLER_RATE_LIMITED" {
		t.Fatalf("masked platform code: got %q", got)
	}
}

func TestLazyLoadCommentBudgetIsExplicit(t *testing.T) {
	r := Request{Kind: "detail", ID: "5f8c574500000000010085bc", Target: 10, Seconds: 300, Comments: true, CommentMode: LimitedLazyLoadOnScroll}
	if err := r.Validate(); err != nil {
		t.Fatal(err)
	}
	r.Seconds = 1801
	if r.Validate() == nil {
		t.Fatal("unbounded duration accepted")
	}
	r.Seconds = 300
	r.CommentMode = "sample"
	if r.Validate() == nil {
		t.Fatal("sample gained a long budget silently")
	}
	// 具名旧模式不再被接受。
	r.CommentMode = "exhaustive"
	if r.Validate() == nil {
		t.Fatal("retired exhaustive mode accepted")
	}
	// 懒加载页数上限越界要拒绝。
	r.CommentMode = LimitedLazyLoadOnScroll
	r.CommentLazyLoadLimit = 21
	if r.Validate() == nil {
		t.Fatal("oversized lazy limit accepted")
	}
}

func TestUnboundedDiscoveryValidation(t *testing.T) {
	for _, r := range []Request{
		{Kind: "search", Keyword: "venue", Target: 0, Seconds: 0},
		{Kind: "search", Keyword: "venue", Target: 25000, Seconds: 7200},
		{Kind: "profile", ID: "5f8c574500000000010085bc", Target: 0, Seconds: 45},
	} {
		if err := r.Validate(); err != nil {
			t.Fatal(err)
		}
	}
	for _, r := range []Request{
		{Kind: "search", Keyword: "venue", Target: -1, Seconds: 0},
		{Kind: "search", Keyword: "venue", Target: 0, Seconds: -1},
	} {
		if r.Validate() == nil {
			t.Fatal("negative budget accepted")
		}
	}
}

// A broken web_session can land on a guest search page with no results instead
// of a login page (2026-10-07 smoke); that empty search is a login wall, and no
// guest read may have its cookies saved over the login.
func TestGuestPageEmptySearchIsALoginWall(t *testing.T) {
	_, err := guestOutcome("search", map[string]any{"stop_reason": "unconfirmed_empty"}, "guest")
	if ErrorCode(err) != "CRAWLER_RELOGIN_REQUIRED" {
		t.Fatalf("guest empty search: got %v", err)
	}
	got, err := guestOutcome("detail", map[string]any{"raw": "x"}, "guest")
	if err != nil || got["guest_session"] != true {
		t.Fatalf("guest detail must be kept and marked: %v %v", got, err)
	}
	got, err = guestOutcome("search", map[string]any{"stop_reason": "unconfirmed_empty"}, "user")
	if err != nil || got["guest_session"] != nil {
		t.Fatalf("a logged-in empty search stays an empty search: %v %v", got, err)
	}
	got, err = guestOutcome("search", map[string]any{"stop_reason": "unconfirmed_empty"}, "")
	if err != nil || got["guest_session"] != nil {
		t.Fatalf("an unknown session state decides nothing: %v %v", got, err)
	}
}

func TestR2BoundedCommentsBudgetAcrossAdapter(t *testing.T) {
	script := `const {nativeRequest}=require('./adapter');process.stdout.write(JSON.stringify(nativeRequest({target:{post_id:'a'.repeat(24)},payload:{platform:'xiaohongshu',operation:'post.detail',params:{native_request:{kind:'detail',id:'a'.repeat(24),comments:true,target:200,seconds:300,comment_mode:'limited_lazy_load_on_scroll',comment_lazy_load_limit:2}},limits:{max_pages:1000,execution_timeout_seconds:600},cache:{mode:'refresh'}}})));`
	command := exec.Command("node", "-e", script)
	command.Dir = "../.."
	data, err := command.Output()
	if err != nil {
		t.Fatal(err)
	}
	var request Request
	if err = json.Unmarshal(data, &request); err != nil {
		t.Fatal(err)
	}
	if request.Target != 200 || request.Seconds != 300 || !request.Comments || request.CommentMode != LimitedLazyLoadOnScroll {
		t.Fatalf("R2 budget changed: %+v", request)
	}
	if err = request.Validate(); err != nil {
		t.Fatalf("valid R2 comments rejected: %v", err)
	}
	request.Target = 201
	if err = request.Validate(); err == nil {
		t.Fatal("unbounded comment target accepted")
	}
	request.Target = 200
	request.CommentMode = "sample"
	request.Seconds = 45
	if err = request.Validate(); err == nil {
		t.Fatal("ordinary sample inherited the R2 target")
	}
}
