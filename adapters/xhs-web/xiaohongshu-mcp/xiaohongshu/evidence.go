package xiaohongshu

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"time"

	"github.com/go-rod/rod"
	"github.com/sirupsen/logrus"
	"github.com/xpzouying/xiaohongshu-mcp/humanize"
)

// SmokeRaw 保留页面实际提供的字段，避免结构体丢失标签、编辑时间和回复关系。
func ReadRawEvidence(ctx context.Context, page *rod.Page, kind, id string) (json.RawMessage, error) {
	page = page.Context(ctx)
	if err := checkAccess(page); err != nil {
		return nil, err
	}
	r, err := page.Eval(`(kind,id) => {
	 const s=window.__INITIAL_STATE__;
	 if(!s) return "";
	 if(kind==="note") return JSON.stringify(s.note?.noteDetailMap?.[id] || null);
	 if(kind==="search") {const f=s.search?.feeds; const rows=f?.value??f?._value??f;return Array.isArray(rows)?JSON.stringify({feeds:rows}):"";}
	 const u=s.user; if(!u) return "";
	 const unwrap=x=>x?.value!==undefined?x.value:(x?._value!==undefined?x._value:x);
	 const active=unwrap(u.activeTab)||{};
	 const notes=unwrap(u.notes)||[];
	 return JSON.stringify({profile:unwrap(u.userPageData),profile_user_id:location.pathname.split('/').filter(Boolean).pop(),active,feeds:notes[active.index||0]||[],
	  dom_cards:[...document.querySelectorAll('section.note-item')].map(e=>({href:e.querySelector('a.cover')?.getAttribute('href'),sticky:e.innerText.includes('置顶')}))});
	}`, kind, id)
	if err != nil {
		return nil, err
	}
	raw := r.Value.Str()
	if raw == "" || raw == "null" {
		return nil, fmt.Errorf("missing %s state", kind)
	}
	return json.RawMessage(raw), nil
}

// SmokeProfile 有界滚动，记录每轮数量，不把停滞误报成全部完成。
// since (epoch ms, 0 = none) ends the scroll at the first unpinned card older
// than it; see scroll_since.go for when that stop is refused.
func ReadProfileEvidence(ctx context.Context, page *rod.Page, uid, token string, target int, since int64, endPolicy string) (map[string]any, error) {
	_, err := NewUserProfileAction(page).UserProfile(ctx, uid, token, TabNotes)
	if err != nil {
		return nil, err
	}
	counts := []int{}
	last := -1
	stalled := 0
	lastGrowth := time.Now()
	stop := "scroll_limit"
	sinceAnomaly := ""
	var sinceOldest int64
	var raw json.RawMessage
	walk, walking := profileWalk(ctx)
	visited := map[string]bool{}
	matched := ""
	for {
		raw, err = ReadRawEvidence(ctx, page.Context(ctx), "profile", uid)
		if err != nil {
			return nil, err
		}
		var obj struct {
			Feeds []json.RawMessage `json:"feeds"`
		}
		if err = json.Unmarshal(raw, &obj); err != nil {
			return nil, err
		}
		n := identifiedProfileCount(obj.Feeds)
		counts = append(counts, n)
		keepReading, observeErr := observePage(ctx, raw)
		if observeErr != nil {
			return nil, observeErr
		}
		if !keepReading {
			stop = "client_stopped"
			break
		}

		if walking {
			var selectedStop string
			anchors := walk.Anchors
			if _, anomaly, _ := sinceReached(obj.Feeds, since); anomaly != "" {
				anchors = nil
			}
			matched, selectedStop, err = visitProfileCards(ctx, obj.Feeds, since, visited, anchors, walk.Skip,
				func(nid string) error { return walk.Before(ctx, nid) }, func(nid, access string) (bool, error) {
					selected := false
					noteCtx := WithShareSelector(ctx, func(inner context.Context, body json.RawMessage) (bool, error) {
						var selectErr error
						selected, selectErr = walk.Select(inner, nid, access, body)
						return selected, selectErr
					})
					detail, readErr := ReadDetailEvidence(noteCtx, page, nid, access, -1, 45, uid)
					if readErr != nil {
						return false, readErr
					}
					keepSelected, err := walk.Observe(ctx, nid, detail)
					if err != nil {
						return false, err
					}
					return selected && keepSelected, nil
				})
			if err != nil {
				return nil, err
			}
			if matched != "" {
				stop = selectedStop
				break
			}
		}
		if target > 0 && n >= target {
			stop = "target_loaded"
			break
		}
		if since > 0 && sinceAnomaly == "" {
			reached, anomaly, oldest := sinceReached(obj.Feeds, since)
			sinceAnomaly, sinceOldest = anomaly, oldest
			if reached {
				stop = "since_reached"
				break
			}
		}
		if n == last {
			stalled++
		} else {
			stalled = 0
			lastGrowth = time.Now()
		}
		last = n
		if scrollStalled(stalled, time.Since(lastGrowth)) {
			stop = "no_growth"
			break
		}
		if pageLimitReached(ctx, len(counts)) {
			stop = "page_limit"
			break
		}
		if err = page.Context(ctx).Mouse.Scroll(0, 850, 1); err != nil {
			return nil, err
		}
		humanize.Delay(ctx, humanize.BetweenScroll)
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
	}
	result := map[string]any{"raw": raw, "loaded_counts": counts, "stop_reason": stop, "requested": target, "end_observed": false}
	if endPolicy == ProfileEndObservationPolicy {
		// Exactly one additional DOM read after each existing bounded Go read.
		// This observation is not a verified profile-terminal contract.
		if stop == "client_stopped" || ctx.Err() != nil {
			result["profile_end_observation"] = unavailableProfileEndObservation("READ_STOPPED")
		} else {
			result["profile_end_observation"] = observeProfileEnd(ctx, page, uid)
		}
	}
	if walking {
		result["profile_walk_version"] = ProfileWalkVersion
		result["matched_note_id"] = matched
	}
	if since > 0 {
		result["since"] = map[string]any{"requested_ms": since, "oldest_unpinned_ms": sinceOldest, "anomaly": sinceAnomaly}
	}
	return result, nil
}

var profileNoteID = regexp.MustCompile(`^[a-fA-F0-9]{24}$`)

// Counts only unique identified notes, never SSR loading placeholders.
func identifiedProfileCount(feeds []json.RawMessage) int {
	seen := make(map[string]bool)
	for _, raw := range feeds {
		var row struct {
			ID     string `json:"id"`
			NoteID string `json:"noteId"`
			Card   struct {
				NoteID string `json:"noteId"`
			} `json:"noteCard"`
		}
		if json.Unmarshal(raw, &row) != nil {
			continue
		}
		id := row.ID
		if id == "" {
			id = row.NoteID
		}
		if id == "" {
			id = row.Card.NoteID
		}
		if profileNoteID.MatchString(id) {
			seen[id] = true
		}
	}
	return len(seen)
}

// SmokeDetail 先保存详情，再有界加载评论；超时仍提取已加载的证据。
//
// author 是已知作者 uid（可为空）；modes 约定：modes[0] 是评论模式（sample 或
// limited_lazy_load_on_scroll），modes[1]（可选）是懒加载页数上限。旧调用不传即
// 样本模式、无作者上下文。
func ReadDetailEvidence(ctx context.Context, page *rod.Page, id, token string, target, seconds int, author string, modes ...string) (output map[string]any, readErr error) {
	lazy := len(modes) > 0 && modes[0] == "limited_lazy_load_on_scroll"
	mode := "sample"
	lazyLimit := defaultLazyLoadLimit
	if lazy {
		mode = "limited_lazy_load_on_scroll"
		if len(modes) > 1 {
			if n, err := strconv.Atoi(modes[1]); err == nil && n > 0 {
				lazyLimit = n
			}
		}
	}
	stopFor := func(raw json.RawMessage) string {
		if lazy {
			if commentsFullyObserved(raw) {
				return "comment_end_observed"
			}
			return ""
		}
		return commentSampleStop(raw, target)
	}
	start := time.Now()
	// [TEMP DEBUG] 分阶段 trace：导航/就绪/首屏评论/加载各阶段的起止与耗时。
	logrus.Infof("[detail] 开始 id=%s author=%s token=%v target=%d seconds=%d mode=%s lazyLimit=%d", id, author, token != "", target, seconds, mode, lazyLimit)
	// Never navigate to the note URL directly. The platform blocks top-level
	// detail documents (the page silently keeps the previous content and stops
	// issuing requests), so open the note from an allowed list page — the author's
	// profile or the search-result list — and click through in-page instead.
	page = page.Context(ctx)
	navigation, openErr := openNoteOnListPage(ctx, page, id, author, token)
	if openErr != nil {
		logrus.Infof("[detail] openNoteOnListPage 失败 耗时=%.1fs err=%v", time.Since(start).Seconds(), openErr)
		return nil, openErr
	}
	logrus.Infof("[detail] openNoteOnListPage 完成 耗时=%.1fs", time.Since(start).Seconds())
	// Every return below (with or without comments, success or not) closes the
	// note overlay, so the author list stays where it was and the next note of
	// the same author is clicked from there instead of reloading the profile and
	// scrolling again from the top. Reads without comments used to return early
	// and leave the overlay open.
	defer func() {
		navigation.CloseMethod, navigation.ListRestored = closeNoteOverlay(ctx, page, id)
		cleanupCtx, cleanupCancel := context.WithTimeout(context.WithoutCancel(ctx), time.Second)
		defer cleanupCancel()
		navigation.DocumentChanged = documentOrigin(page.Context(cleanupCtx)) != navigation.listDocument
		if output != nil {
			output["navigation"] = navigation
			output["total_seconds"] = time.Since(start).Seconds()
		}
	}()
	readyCtx, readyCancel := context.WithTimeout(ctx, 40*time.Second)
	defer readyCancel()
	var initial json.RawMessage
	previewOnly := false
	for {
		if err := checkAccess(page.Context(readyCtx)); err != nil {
			logrus.Infof("[detail] checkAccess 失败 耗时=%.1fs err=%v", time.Since(start).Seconds(), err)
			return nil, err
		}
		// 帖子不存在时平台把它从列表移除并 302 到 /other；这时无论等多久都不会
		// 出现详情，立即按 NOTE_STATE_UNAVAILABLE 跳过（单帖失败，不拖满 40 秒）。
		if noteGoneByPath(page.Context(readyCtx)) {
			logrus.Infof("[detail] 帖子不存在（已落到占位页） 耗时=%.1fs id=%s", time.Since(start).Seconds(), id)
			return nil, fmt.Errorf("NOTE_STATE_UNAVAILABLE: %w", errNoteGone)
		}
		candidate, err := ReadRawEvidence(readyCtx, page.Context(readyCtx), "note", id)
		if err == nil {
			var state struct {
				Note struct {
					ID   string `json:"noteId"`
					User struct {
						ID string `json:"userId"`
					} `json:"user"`
				} `json:"note"`
			}
			if json.Unmarshal(candidate, &state) == nil && state.Note.ID == id && state.Note.User.ID != "" {
				// Clicking a list card seeds noteDetailMap with the card preview
				// (id, user, title, cover) before the detail response lands.
				// Accepting it returned a body-less "success" that was cached.
				if hasDetailFields(candidate) {
					initial = candidate
					break
				}
				previewOnly = true
			}
		}
		select {
		case <-readyCtx.Done():
			if previewOnly {
				logrus.Infof("[detail] DETAIL_PAYLOAD_INCOMPLETE 耗时=%.1fs id=%s", time.Since(start).Seconds(), id)
				return nil, fmt.Errorf("DETAIL_PAYLOAD_INCOMPLETE: %w", readyCtx.Err())
			}
			logrus.Infof("[detail] NOTE_STATE_UNAVAILABLE 耗时=%.1fs err=%v", time.Since(start).Seconds(), readyCtx.Err())
			return nil, fmt.Errorf("NOTE_STATE_UNAVAILABLE: %w", readyCtx.Err())
		case <-time.After(250 * time.Millisecond):
		}
	}
	logrus.Infof("[detail] note ready 耗时=%.1fs", time.Since(start).Seconds())
	bodySeconds := time.Since(start).Seconds()
	selectStarted := time.Now()
	wanted, selectErr := selectShare(ctx, initial)
	selectionSeconds := time.Since(selectStarted).Seconds()
	if selectErr != nil {
		return nil, selectErr
	}
	shareStarted := time.Now()
	shareURL, shareStatus := "", "not_requested"
	if wanted {
		shareURL, shareStatus = captureNoteShare(ctx, page, id)
	}
	shareSeconds := time.Since(shareStarted).Seconds()
	defer func() {
		if output != nil {
			output["share_url"], output["share_status"] = shareURL, shareStatus
			output["share_selection_version"] = ShareSelectionVersion
			output["body_seconds"], output["selection_seconds"], output["share_seconds"] = bodySeconds, selectionSeconds, shareSeconds
		}
	}()
	detailSeconds := time.Since(start).Seconds()
	if target < 0 {
		return map[string]any{"raw": initial, "detail_seconds": detailSeconds, "total_seconds": time.Since(start).Seconds(), "stop_reason": "comments_not_requested", "comments_requested": false}, nil
	}
	// Initial state often already contains every reported comment. Starting a
	// DOM scroll before the comment container mounts can otherwise panic even
	// when all three or four comments are already available.
	if stop := stopFor(initial); stop != "" {
		return map[string]any{"raw": initial, "detail_seconds": detailSeconds, "total_seconds": time.Since(start).Seconds(), "comment_target": target, "comment_seconds_limit": seconds, "stop_reason": stop, "end_observed": lazy, "comments_requested": true, "comment_mode": mode, "comment_lazy_load_limit": lazyLimit, "comment_lazy_load_pages": 0, "comments_complete": lazy, "reply_coverage": "observed_state"}, nil
	}
	loadCtx, cancel := context.WithTimeout(ctx, time.Duration(seconds)*time.Second)
	defer cancel()
	// 详情 SSR 就绪不代表评论首屏已加载；等实际评论状态，避免过早滚动挂起。
	logrus.Infof("[detail] waitInitialComments 开始 耗时=%.1fs budget=%ds", time.Since(start).Seconds(), seconds)
	readyRaw, readyErr := waitInitialComments(loadCtx, page, id)
	logrus.Infof("[detail] waitInitialComments 完成 耗时=%.1fs err=%v got=%v", time.Since(start).Seconds(), readyErr, readyRaw != nil)
	if readyRaw != nil {
		initial = readyRaw
	}
	if stop := stopFor(initial); readyErr == nil && stop != "" {
		logrus.Infof("[detail] 首屏即完成 stop=%s 耗时=%.1fs", stop, time.Since(start).Seconds())
		return map[string]any{"raw": initial, "detail_seconds": detailSeconds, "total_seconds": time.Since(start).Seconds(), "comment_target": target, "comment_seconds_limit": seconds, "stop_reason": stop, "end_observed": lazy, "comments_requested": true, "comment_mode": mode, "comment_lazy_load_limit": lazyLimit, "comment_lazy_load_pages": 0, "comments_complete": lazy, "reply_coverage": "observed_state"}, nil
	}
	replyThreshold := 100
	if lazy {
		replyThreshold = 0
	}
	// 不预绑定 loadCtx 到 loader.page：保持原始 page，load 内部每次调用再
	// Context(ctx)，确保 rod 每次都用调用方当下的 deadline/Timeout。
	loader := &commentLoader{page: page, noteID: id, config: CommentLoadConfig{LazyLoadOnScroll: lazy, LazyLoadLimit: lazyLimit, ClickMoreReplies: true, MaxRepliesThreshold: replyThreshold, MaxCommentItems: target, ScrollSpeed: "normal"}, stats: &loadStats{}, state: &loadState{}}
	loadErr := func() (loadErr error) {
		if readyErr != nil {
			return readyErr
		}
		defer func() {
			if r := recover(); r != nil {
				loadErr = fmt.Errorf("comment load interrupted: %v", r)
			}
		}()
		logrus.Infof("[detail] loader.load 开始 耗时=%.1fs", time.Since(start).Seconds())
		err := loader.load(loadCtx)
		logrus.Infof("[detail] loader.load 返回 耗时=%.1fs err=%v rounds=%d pages=%d", time.Since(start).Seconds(), err, loader.stats.attempts, loader.state.lazyRounds)
		return err
	}()
	cancel()
	raw, rawErr := ReadRawEvidence(ctx, page.Context(ctx), "note", id)
	if rawErr != nil {
		raw = initial
		if len(loader.lastRaw) > 0 {
			raw = loader.lastRaw
		}
	}
	stop := "loader_returned"
	if loadErr != nil {
		stop = "time_limit_or_load_error"
		if sampleStop := stopFor(raw); rawErr == nil && sampleStop != "" {
			stop = sampleStop
		}
	}
	end := false
	func() {
		defer func() { _ = recover() }()
		end = checkEndContainer(ctx, page.Context(ctx)) || checkNoCommentsArea(ctx, page.Context(ctx))
	}()
	pages := loader.state.lazyRounds
	limitReached := loader.stats.lazyLimitReached
	complete := lazy && rawErr == nil && commentsFullyObserved(raw)
	if lazy {
		// 懒加载是有界采集：触发到页数上限即视为本次契约已完成（comments_complete），
		// 页面正好自然结束时也算完成。中途被超时/加载错误打断则保持 partial。
		complete = complete || (limitReached && loadErr == nil)
		switch {
		case stop == "time_limit_or_load_error":
		case limitReached:
			stop = "comment_lazy_load_limit_reached"
		case complete:
			// 未触及页数上限但页面自然结束（父评论列表 hasMore=false）。
			stop = "comment_end_observed"
		case loadErr == nil:
			stop = "comment_incomplete"
		}
	}
	result := map[string]any{"raw": raw, "initial_raw": initial, "detail_seconds": detailSeconds, "total_seconds": time.Since(start).Seconds(), "comment_target": target, "comment_seconds_limit": seconds, "end_observed": end, "stop_reason": stop, "loader_interrupted": loadErr != nil, "reply_buttons_clicked": loader.stats.totalClicked, "reply_buttons_skipped": loader.stats.totalSkipped, "scroll_attempts": loader.stats.attempts, "final_extraction_failed": rawErr != nil, "comment_mode": mode, "comment_lazy_load_limit": lazyLimit, "comment_lazy_load_pages": pages, "comments_complete": complete}
	// Preserve a restriction observed during comments even when retaining the
	// previously captured note as a partial result. Do not alter that policy.
	var access *AccessError
	if errors.As(rawErr, &access) || errors.As(loadErr, &access) {
		result["access_diagnostic"] = access.Diagnostic
	}
	return result, nil
}

// Complete only when the page explicitly finished both parent and reply lists.
// A parent target, "THE END" marker or approximate public counter is insufficient.
func commentsFullyObserved(raw json.RawMessage) bool {
	var state struct {
		Comments struct {
			FirstRequestFinish bool  `json:"firstRequestFinish"`
			Loading            bool  `json:"loading"`
			HasMore            *bool `json:"hasMore"`
			List               []struct {
				ID             string `json:"id"`
				Count          any    `json:"subCommentCount"`
				HasMore        *bool  `json:"subCommentHasMore"`
				Expanded       bool   `json:"expended"`
				CurrentHasMore *bool  `json:"hasMore"`
				Replies        []struct {
					ID string `json:"id"`
				} `json:"subComments"`
			} `json:"list"`
		} `json:"comments"`
	}
	if json.Unmarshal(raw, &state) != nil {
		return false
	}
	c := state.Comments
	if !c.FirstRequestFinish || c.Loading || c.HasMore == nil || *c.HasMore {
		return false
	}
	for _, p := range c.List {
		// After expansion the web store updates hasMore, while the initial
		// subCommentHasMore can remain true. Never use that stale initial flag.
		replyHasMore := p.HasMore
		if p.Expanded {
			replyHasMore = p.CurrentHasMore
		}
		if p.ID == "" || (replyHasMore != nil && *replyHasMore) {
			return false
		}
		count, err := strconv.Atoi(fmt.Sprint(p.Count))
		if err != nil || count < 0 {
			return false
		}
		seen := map[string]bool{}
		for _, r := range p.Replies {
			if r.ID != "" {
				seen[r.ID] = true
			}
		}
		if len(seen) < count || (count > 0 && replyHasMore == nil) {
			return false
		}
	}
	return true
}

// 满足有界父评论样本即可停止，保留已观察回复，不声称完整回复分页。
func commentSampleStop(raw json.RawMessage, target int) string {
	if observedReportedComments(raw) {
		return "reported_count_observed"
	}
	var state struct {
		Comments struct {
			List []struct {
				ID string `json:"id"`
			} `json:"list"`
		} `json:"comments"`
	}
	if target < 1 || json.Unmarshal(raw, &state) != nil {
		return ""
	}
	seen := map[string]bool{}
	for _, comment := range state.Comments.List {
		if comment.ID != "" {
			seen[comment.ID] = true
		}
	}
	if len(seen) >= target {
		return "parent_target_observed"
	}
	return ""
}

func commentsReady(raw json.RawMessage) bool {
	var state struct {
		Comments struct {
			FirstRequestFinish bool              `json:"firstRequestFinish"`
			List               []json.RawMessage `json:"list"`
		} `json:"comments"`
	}
	return json.Unmarshal(raw, &state) == nil && (state.Comments.FirstRequestFinish || len(state.Comments.List) > 0)
}

func waitInitialComments(ctx context.Context, page *rod.Page, id string) (json.RawMessage, error) {
	var latest json.RawMessage
	for {
		if raw, err := ReadRawEvidence(ctx, page.Context(ctx), "note", id); err == nil {
			latest = raw
			if commentsReady(raw) {
				return raw, nil
			}
		}
		// A verification/rate-limit overlay blocks the comment area; wait it out
		// instead of polling an unchanging state until the budget expires.
		if err := WaitForRestrictionOverlay(ctx, page); err != nil {
			return latest, err
		}
		select {
		case <-ctx.Done():
			return latest, ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
}

func observedReportedComments(raw json.RawMessage) bool {
	var state struct {
		Note struct {
			Interact struct {
				Count any `json:"commentCount"`
			} `json:"interactInfo"`
		} `json:"note"`
		Comments struct {
			List []struct {
				ID      string `json:"id"`
				Replies []struct {
					ID string `json:"id"`
				} `json:"subComments"`
			} `json:"list"`
		} `json:"comments"`
	}
	if json.Unmarshal(raw, &state) != nil || state.Note.Interact.Count == nil {
		return false
	}
	reported, err := strconv.Atoi(fmt.Sprint(state.Note.Interact.Count))
	if err != nil || reported < 0 {
		return false
	}
	seen := map[string]bool{}
	for _, parent := range state.Comments.List {
		if parent.ID != "" {
			seen[parent.ID] = true
		}
		for _, reply := range parent.Replies {
			if reply.ID != "" {
				seen[reply.ID] = true
			}
		}
	}
	return len(seen) >= reported
}
