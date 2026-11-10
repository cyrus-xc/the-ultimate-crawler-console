// Package crawler 是只读引擎，不依赖 MCP 协议或付费 API。
package crawler

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-rod/rod"
	"github.com/sirupsen/logrus"
	"github.com/xpzouying/xiaohongshu-mcp/browser"
	"github.com/xpzouying/xiaohongshu-mcp/xiaohongshu"
)

const Version = "xhs_crawler_v1"
const NavigationVersion = xiaohongshu.NoteNavigationVersion
const ShareSelectionVersion = xiaohongshu.ShareSelectionVersion
const ProfileWalkVersion = xiaohongshu.ProfileWalkVersion

type Request struct {
	MaxPages         int      `json:"max_pages,omitempty"`
	StreamPages      bool     `json:"stream_pages,omitempty"`
	ProfileWalk      bool     `json:"profile_walk,omitempty"`
	WalkVersion      string   `json:"profile_walk_version,omitempty"`
	ProfileAnchors   []string `json:"profile_anchor_ids,omitempty"`
	ProfileSkip      []string `json:"profile_skip_ids,omitempty"`
	ProfileEndPolicy string   `json:"profile_end_policy,omitempty"`
	CaptureShare     bool     `json:"capture_share,omitempty"`
	SelectShare      bool     `json:"select_share,omitempty"`
	Kind             string   `json:"kind" jsonschema:"profile, detail or search"`
	ID               string   `json:"id,omitempty" jsonschema:"User ID or note ID"`
	Keyword          string   `json:"keyword,omitempty" jsonschema:"Search keyword"`
	Token            string   `json:"xsec_token,omitempty" jsonschema:"Private web access context"`
	UserID           string   `json:"user_id,omitempty" jsonschema:"Known note author, used only for tab routing"`
	Target           int      `json:"target,omitempty" jsonschema:"Card or parent comment target, 1 to 100; bounded comments up to 200"`
	Seconds          int      `json:"seconds,omitempty" jsonschema:"Comment time budget: sample 1..90, limited_lazy_load_on_scroll 1..1800 seconds"`
	Comments         bool     `json:"comments,omitempty" jsonschema:"Load parent comments and replies"`
	CommentMode      string   `json:"comment_mode,omitempty" jsonschema:"sample or limited_lazy_load_on_scroll (bounded scroll-triggered lazy loading)"`
	// CommentLazyLoadLimit 是 limited_lazy_load_on_scroll 模式下的懒加载页数上限：
	// 每轮滚动懒加载算一页，达到该页数即停。0 使用默认（2）。其他模式忽略。
	CommentLazyLoadLimit int    `json:"comment_lazy_load_limit,omitempty" jsonschema:"Scroll-triggered lazy-load page budget, default 2"`
	SortBy               string `json:"sort_by,omitempty"`
	// Since（毫秒）仅用于 profile：滚动到第一条早于它的非置顶卡片即停。
	Since int64 `json:"since,omitempty" jsonschema:"Profile only: stop at the first unpinned card published before this epoch ms"`
}

var idPattern = regexp.MustCompile(`^[a-fA-F0-9]{24}$`)
var poiPattern = regexp.MustCompile(`^[a-fA-F0-9]{8,64}$`)

func (r Request) Validate() error {
	if r.ProfileEndPolicy != "" && (r.ProfileEndPolicy != xiaohongshu.ProfileEndObservationPolicy || r.Kind != "profile" || r.ProfileWalk || r.Since != 0 || r.Target <= 0) {
		return errors.New("INVALID_PROFILE_END_POLICY")
	}
	if r.MaxPages < 0 || r.MaxPages > 1000 {
		return errors.New("INVALID_PAGE_LIMIT")
	}
	if r.ProfileWalk && r.WalkVersion != ProfileWalkVersion || !r.ProfileWalk && r.WalkVersion != "" {
		return errors.New("INVALID_PROFILE_WALK")
	}
	if !r.ProfileWalk && (len(r.ProfileAnchors) > 0 || len(r.ProfileSkip) > 0) {
		return errors.New("INVALID_PROFILE_WALK")
	}
	for _, nid := range append(append([]string{}, r.ProfileAnchors...), r.ProfileSkip...) {
		if !idPattern.MatchString(nid) {
			return errors.New("INVALID_PROFILE_WALK")
		}
	}
	if r.ProfileWalk && (r.Kind != "profile" || r.Target != 0 || r.SelectShare || r.CaptureShare) {
		return errors.New("INVALID_PROFILE_WALK")
	}
	if (r.CaptureShare || r.SelectShare) && r.Kind != "detail" || (r.CaptureShare && r.SelectShare) {
		return errors.New("INVALID_SHARE_SELECTION")
	}
	if r.UserID != "" && (r.Kind != "detail" || !idPattern.MatchString(r.UserID)) {
		return errors.New("INVALID_ID")
	}
	if r.Kind != "profile" && r.Kind != "detail" && r.Kind != "search" && r.Kind != "poi" {
		return errors.New("INVALID_KIND")
	}
	if r.Kind == "search" {
		if strings.TrimSpace(r.Keyword) == "" || len([]rune(r.Keyword)) > 200 || r.ID != "" || r.Comments {
			return errors.New("INVALID_SEARCH")
		}
	} else if r.Kind == "poi" {
		if !poiPattern.MatchString(r.ID) || r.Keyword != "" || r.Comments {
			return errors.New("INVALID_ID")
		}
	} else if !idPattern.MatchString(r.ID) || r.Keyword != "" {
		return errors.New("INVALID_ID")
	}
	if r.Kind == "profile" && r.Comments {
		return errors.New("INVALID_COMMENTS")
	}
	if r.Since < 0 || (r.Since > 0 && r.Kind != "profile") {
		return errors.New("INVALID_SINCE")
	}
	maxSeconds := 90
	maxTarget := 100

	if r.SortBy != "" {
		if r.Kind != "search" {
			return errors.New("INVALID_SEARCH")
		}
		switch r.SortBy {
		case "综合", "最新", "最多点赞", "最多评论", "最多收藏":
		default:
			return errors.New("INVALID_SEARCH")
		}
	}
	if r.CommentMode != "" && r.CommentMode != "sample" && r.CommentMode != LimitedLazyLoadOnScroll {
		return errors.New("INVALID_COMMENTS")
	}
	if r.CommentMode == LimitedLazyLoadOnScroll {
		if r.Kind != "detail" || !r.Comments {
			return errors.New("INVALID_COMMENTS")
		}
		maxSeconds = 1800
		maxTarget = 200
	}
	if r.CommentLazyLoadLimit < 0 || r.CommentLazyLoadLimit > 20 {
		return errors.New("INVALID_COMMENTS")
	}
	if (r.Kind == "search" && (r.Target < 0 || r.Seconds < 0)) || (r.Kind != "search" && ((r.Target < 1 && !(r.Kind == "profile" && r.Target == 0)) || r.Target > maxTarget || r.Seconds < 1 || r.Seconds > maxSeconds)) {
		return errors.New("INVALID_BUDGET")
	}
	return nil
}

func (e *Engine) Read(ctx context.Context, r Request) (result map[string]any, err error) {
	if err = r.Validate(); err != nil {
		return nil, err
	}
	if r.SelectShare && !xiaohongshu.HasShareSelector(ctx) {
		return nil, errors.New("INVALID_SHARE_SELECTION")
	}
	if r.ProfileWalk && !xiaohongshu.HasProfileWalk(ctx) {
		return nil, errors.New("INVALID_PROFILE_WALK")
	}
	if r.MaxPages > 0 && !r.StreamPages {
		ctx = xiaohongshu.WithPageControl(ctx, xiaohongshu.PageControl{Limit: r.MaxPages})
	}
	trace := newReadTrace()
	defer func() {
		if recovered := recover(); recovered != nil {
			result = nil
			err = errBrowserInterrupted
			logrus.Infof("[engine.Read] recovered panic kind=%s id=%s panic=%s", r.Kind, r.ID, panicText(recovered))
		}
		diagnostic := trace.finish(err)
		if access, ok := result["access_diagnostic"].(xiaohongshu.AccessDiagnostic); ok {
			diagnostic.Access = &access
			delete(result, "access_diagnostic")
		}
		if err != nil {
			err = &diagnosticError{cause: err, diagnostic: diagnostic}
		} else if result != nil {
			result["diagnostics"] = diagnostic
		}
	}()
	budget := 150 * time.Second
	if r.CommentMode == LimitedLazyLoadOnScroll {
		// 有界懒加载只触发有限页数；把内部预算放宽到 50s，给滚动懒加载更多余量。
		// Python 侧 lazy 模式 read timeout 为 600s，不会因此提前断连。
		if r.Seconds > 0 && r.Seconds < 50 {
			budget = time.Duration(r.Seconds) * time.Second
		} else {
			budget = 50 * time.Second
		}
	}
	if r.Kind == "search" {
		budget = time.Duration(r.Seconds+60) * time.Second
	}
	start := time.Now()
	logrus.Infof("[engine.Read] start kind=%s id=%s keyword=%q comment_mode=%s seconds=%d lazy_limit=%d go_budget=%.1fs",
		r.Kind, r.ID, r.Keyword, r.CommentMode, r.Seconds, r.CommentLazyLoadLimit, budget.Seconds())
	var cancel context.CancelFunc
	if (r.Kind == "search" && r.Seconds == 0) || (r.Kind == "profile" && r.Target == 0) {
		ctx, cancel = context.WithCancel(ctx)
	} else {
		ctx, cancel = context.WithTimeout(ctx, budget)
	}
	defer func() {
		logrus.Infof("[engine.Read] end kind=%s id=%s keyword=%q err=%v elapsed=%.1fs", r.Kind, r.ID, r.Keyword, err, time.Since(start).Seconds())
	}()
	defer cancel()
	select {
	case e.slots <- struct{}{}:
		defer func() { <-e.slots }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	return e.readSession(ctx, r, trace)
}

func readPage(ctx context.Context, page *rod.Page, r Request) (map[string]any, error) {
	if deadline, ok := ctx.Deadline(); ok {
		logrus.Infof("[readPage] start kind=%s id=%s keyword=%q actual_deadline=%.1fs", r.Kind, r.ID, r.Keyword, time.Until(deadline).Seconds())
	} else {
		logrus.Infof("[readPage] start kind=%s id=%s keyword=%q actual_deadline=none", r.Kind, r.ID, r.Keyword)
	}
	if err := browser.PrepareTextEvidence(page.Context(ctx)); err != nil {
		return nil, err
	}
	result, err := readKind(ctx, page, r)
	if err != nil {
		return result, err
	}
	return guestOutcome(r.Kind, result, xiaohongshu.SessionState(ctx, page))
}

func readKind(ctx context.Context, page *rod.Page, r Request) (map[string]any, error) {
	switch r.Kind {
	case "poi":
		return xiaohongshu.ReadPOIEvidence(ctx, page, r.ID)
	case "profile":
		return xiaohongshu.ReadProfileEvidence(ctx, page, r.ID, r.Token, r.Target, r.Since, r.ProfileEndPolicy)
	case "search":
		return xiaohongshu.ReadSearchEvidenceWithBudget(ctx, page, r.Keyword, r.Target, r.Seconds, r.SortBy)
	default:
		if r.CaptureShare {
			ctx = xiaohongshu.WithShareSelector(ctx, func(context.Context, json.RawMessage) (bool, error) { return true, nil })
		}
		target := r.Target
		if !r.Comments {
			target = -1
		}
		return xiaohongshu.ReadDetailEvidence(ctx, page, r.ID, r.Token, target, r.Seconds, r.UserID, commentModeArgs(r)...)
	}
}

// guestOutcome applies the page's session state to a finished read. A guest
// (logged-out) page that returned an empty search is a login wall, not an
// empty result; any other read on a guest page is kept but marked, so its
// cookies are never saved over the login (session.go).
func guestOutcome(kind string, result map[string]any, state string) (map[string]any, error) {
	if state != "guest" {
		return result, nil
	}
	if kind == "search" && result["stop_reason"] == "unconfirmed_empty" {
		return nil, &xiaohongshu.AccessError{Code: "CRAWLER_RELOGIN_REQUIRED"}
	}
	result["guest_session"] = true
	return result, nil
}

// LimitedLazyLoadOnScroll 是有界的评论模式：靠滚动触发懒加载，最多展开
// CommentLazyLoadLimit 页即停，不再追求页面明确结束。
const LimitedLazyLoadOnScroll = "limited_lazy_load_on_scroll"

// commentModeArgs 把模式与懒加载页数上限压成 ReadDetailEvidence 的可变参数。
func commentModeArgs(r Request) []string {
	if r.CommentMode == "" || r.CommentMode == "sample" {
		return nil
	}
	args := []string{r.CommentMode}
	if r.CommentMode == LimitedLazyLoadOnScroll {
		limit := r.CommentLazyLoadLimit
		if limit <= 0 {
			limit = 2
		}
		args = append(args, strconv.Itoa(limit))
	}
	return args
}

// 不把包含访问令牌的浏览器异常放入公开结果。
func ErrorCode(err error) string {
	if err == nil {
		return ""
	}
	// A typed platform classification wins over string scanning. The profile and
	// search wrappers prefix their own code ("PROFILE_STATE_UNAVAILABLE: ..."),
	// so a string scan would return that generic wrapper and mask the embedded
	// CRAWLER_RELOGIN_REQUIRED / CRAWLER_ACCESS_RESTRICTED the platform actually
	// reported — the operator then sees the wrong cause and fix.
	var access *xiaohongshu.AccessError
	if errors.As(err, &access) && access != nil && access.Code != "" {
		return access.Code
	}
	s := err.Error()
	for _, code := range []string{"INVALID_PROFILE_WALK", "CRAWLER_RATE_LIMITED", "CRAWLER_ACCESS_RESTRICTED", "CRAWLER_BROWSER_UNRESPONSIVE", "DETAIL_AUTHOR_MISMATCH", "INVALID_SHARE_SELECTION", "CRAWLER_SHARE_SELECTION_TIMEOUT", "INVALID_KIND", "INVALID_SEARCH", "INVALID_ID", "INVALID_COMMENTS", "INVALID_BUDGET", "DETAIL_PAYLOAD_INCOMPLETE", "NOTE_STATE_UNAVAILABLE", "SEARCH_STATE_UNAVAILABLE", "PROFILE_STATE_UNAVAILABLE", "CRAWLER_BROWSER_INTERRUPTED", "CRAWLER_VERIFICATION_REQUIRED", "CRAWLER_RELOGIN_REQUIRED"} {
		if strings.Contains(s, code) {
			return code
		}
	}
	if isNetworkError(err) {
		return "CRAWLER_NETWORK_UNAVAILABLE"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "CRAWLER_TIMEOUT"
	}
	return "CRAWLER_ACCESS_UNAVAILABLE"
}

// Chromium network-layer failures: the page never loaded, so this is the
// connection, proxy or VPN path, not an XHS access decision. On 2026-10-05 an
// OS proxy pointed at a local sandbox made every profile fail with
// net::ERR_CONNECTION_CLOSED, which used to surface as the misleading generic
// CRAWLER_ACCESS_UNAVAILABLE ("check for an access restriction").
var networkErrorMarkers = []string{
	"net::ERR_CONNECTION_CLOSED", "net::ERR_CONNECTION_RESET", "net::ERR_CONNECTION_REFUSED",
	"net::ERR_CONNECTION_TIMED_OUT", "net::ERR_CONNECTION_FAILED", "net::ERR_TIMED_OUT",
	"net::ERR_NAME_NOT_RESOLVED", "net::ERR_INTERNET_DISCONNECTED", "net::ERR_NETWORK_CHANGED",
	"net::ERR_ADDRESS_UNREACHABLE", "net::ERR_EMPTY_RESPONSE", "net::ERR_PROXY_CONNECTION_FAILED",
	"net::ERR_TUNNEL_CONNECTION_FAILED", "net::ERR_SSL_PROTOCOL_ERROR",
}

func isNetworkError(err error) bool {
	if err == nil {
		return false
	}
	s := err.Error()
	for _, marker := range networkErrorMarkers {
		if strings.Contains(s, marker) {
			return true
		}
	}
	return false
}
