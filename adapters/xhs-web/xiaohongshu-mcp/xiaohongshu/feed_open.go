package xiaohongshu

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/input"
	"github.com/go-rod/rod/lib/proto"
	"github.com/sirupsen/logrus"
	"github.com/xpzouying/xiaohongshu-mcp/humanize"
	"time"
)

const noteCardHrefJS = `(id) => {
 const links=[...document.querySelectorAll('section.note-item a.cover')];
 return JSON.stringify({hit:links.some(a=>(a.getAttribute('href')||'').includes(id)),n:links.length});
}`

// Locate the native card, including scrollable ancestors, and keep the list
// position before the website opens its modal. Never log card hrefs/tokens.
const clickNoteCardJS = `(id) => {
 const a=[...document.querySelectorAll('section.note-item a.cover')].find(a=>(a.getAttribute('href')||'').includes(id));
 if(!a)return 'gone';
 a.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
 const elements=new Set([document.scrollingElement]);
 for(let e=a;e;e=e.parentElement)if(e.scrollHeight>e.clientHeight)elements.add(e);
 window.__xhsCrawlerList={url:location.href,document:performance.timeOrigin,
  positions:[...elements].filter(Boolean).map(e=>({e,top:e.scrollTop,left:e.scrollLeft}))};
 a.click();return 'clicked';
}`

const cardScrollAttempts = 6

// A lost/wrong author grid is loaded at most once in this request. Missing
// cards use bounded grid seeking or the SPA router, never document anchors.
func openNoteOnListPage(ctx context.Context, page *rod.Page, noteID, authorID, token string) (noteNavigation, error) {
	nav := noteNavigation{Version: NoteNavigationVersion}
	if err := checkAccess(page.Context(ctx)); err != nil {
		return nav, err
	}
	if noteOverlayOpen(page.Context(ctx)) {
		closeNoteOverlay(ctx, page, noteID)
	}
	if authorID != "" {
		for i := 0; i < 4 && !onAuthorListPage(ctx, page, authorID); i++ {
			if err := navigationPause(ctx, 250*time.Millisecond); err != nil {
				return nav, err
			}
		}
		if !onAuthorListPage(ctx, page, authorID) {
			nav.ProfileLoads++
			if _, err := NewUserProfileAction(page).UserProfile(ctx, authorID, "", TabNotes); err != nil {
				return nav, err
			}
		}
		if !onAuthorListPage(ctx, page, authorID) {
			return nav, fmt.Errorf("NOTE_CARD_NOT_FOUND")
		}
	} else if !onSearchListPage(ctx, page) {
		navCtx, cancel := context.WithTimeout(ctx, navTimeout)
		err := page.Context(navCtx).Navigate(makeSearchURL(noteID))
		cancel()
		if err != nil {
			return nav, err
		}
		if err = waitEvidenceReady(ctx, page, searchReadyJS); err != nil {
			return nav, err
		}
	}
	nav.listDocument = documentOrigin(page.Context(ctx))
	if err := clickNoteCard(ctx, page, noteID, &nav); err == nil {
		nav.OpenMethod = "card"
		return nav, nil
	} else if err.Error() != "NOTE_CARD_NOT_FOUND" {
		return nav, err
	}
	if token != "" {
		_, _ = page.Context(ctx).Eval(rememberListJS)
		if r, err := page.Context(ctx).Timeout(5*time.Second).Eval(routerNoteJS, noteID, token); err == nil && r.Value.Str() == "clicked" {
			nav.OpenMethod = "router"
			return nav, nil
		}
	}
	return nav, fmt.Errorf("NOTE_CARD_NOT_FOUND")
}

func onAuthorListPage(ctx context.Context, page *rod.Page, authorID string) bool {
	if authorID == "" || noteOverlayOpen(page.Context(ctx)) {
		return false
	}
	r, err := page.Context(ctx).Timeout(2*time.Second).Eval(`(uid) => location.pathname==='/user/profile/'+uid && document.querySelectorAll('section.note-item a.cover').length>0`, authorID)
	return err == nil && r.Value.Bool()
}

func onSearchListPage(ctx context.Context, page *rod.Page) bool {
	r, err := page.Context(ctx).Timeout(2 * time.Second).Eval(`() => location.pathname.startsWith('/search_result')`)
	return err == nil && r.Value.Bool()
}

func navigationPause(ctx context.Context, d time.Duration) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(d):
		return nil
	}
}

// Cleanup is bounded independently of a timed-out read. Never click guessed
// coordinates: stale/invisible modals must not activate the site logo.
func closeNoteOverlay(ctx context.Context, page *rod.Page, noteID string) (string, bool) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	page = page.Context(ctx)
	method := "none"
	if err := checkAccess(page); err != nil {
		return "access_blocked", false
	}
	if noteOverlayOpen(page) {
		controlCtx, controlCancel := context.WithTimeout(ctx, time.Second)
		control, err := page.Context(controlCtx).ElementByJS(rod.Eval(closeNoteControlJS))
		if err == nil && control.Click(proto.InputMouseButtonLeft, 1) == nil {
			method = "close_button"
		}
		controlCancel()
		// State can stay visible during the site's close transition after X
		// succeeds. Wait for that bounded transition before using a fallback;
		// ordinary closes return immediately and do not pay a fixed delay.
		for i := 0; i < 10 && noteOverlayOpen(page); i++ {
			if navigationPause(ctx, 100*time.Millisecond) != nil {
				break
			}
		}
		if noteOverlayOpen(page) {
			_ = page.Keyboard.Press(input.Escape)
			method = "escape"
			_ = navigationPause(ctx, 200*time.Millisecond)
		}
	}
	if !listRestored(page) {
		if r, err := page.Eval(returnToListJS); err == nil && r.Value.Bool() {
			method = "history_back"
			for i := 0; i < 8 && !listRestored(page); i++ {
				if navigationPause(ctx, 100*time.Millisecond) != nil {
					break
				}
			}
		}
	}
	restored := listRestored(page)
	if restored {
		r, err := page.Eval(restoreListJS)
		restored = err == nil && r.Value.Bool()
	}
	logrus.Infof("[navigation] close=%s list_restored=%v note=%s", method, restored, noteID)
	return method, restored
}

func listRestored(page *rod.Page) bool {
	if noteOverlayOpen(page) {
		return false
	}
	r, err := page.Timeout(time.Second).Eval(`() => {
 const s=window.__xhsCrawlerList;
 return !!(s&&s.document===performance.timeOrigin&&new URL(s.url).pathname===location.pathname&&document.querySelector('section.note-item a.cover'));
 }`)
	return err == nil && r.Value.Bool()
}

func noteOverlayOpen(page *rod.Page) bool {
	r, err := page.Timeout(time.Second).Eval(visibleNoteJS)
	return err == nil && r.Value.Bool()
}

func documentOrigin(page *rod.Page) float64 {
	r, err := page.Timeout(time.Second).Eval(`() => performance.timeOrigin`)
	if err != nil {
		return 0
	}
	return r.Value.Num()
}

func clickNoteCard(ctx context.Context, page *rod.Page, noteID string, nav *noteNavigation) error {
	if err := WaitForRestrictionOverlay(ctx, page); err != nil {
		return err
	}
	for attempt := 0; attempt < cardScrollAttempts; attempt++ {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		r, err := page.Context(ctx).Timeout(3*time.Second).Eval(noteCardHrefJS, noteID)
		if err != nil {
			return err
		}
		var found struct {
			Hit bool `json:"hit"`
			N   int  `json:"n"`
		}
		if err = json.Unmarshal([]byte(r.Value.Str()), &found); err != nil {
			return err
		}
		if found.Hit {
			humanize.Delay(ctx, humanize.BeforeClick)
			clicked, err := page.Context(ctx).Timeout(3*time.Second).Eval(clickNoteCardJS, noteID)
			if err != nil {
				return err
			}
			if clicked.Value.Str() == "clicked" {
				return nil
			}
		}
		if attempt == cardScrollAttempts-1 {
			break
		}
		distance := 900.0
		if r, err := page.Context(ctx).Timeout(time.Second).Eval(seekNoteJS, noteID); err == nil {
			distance = r.Value.Num()
		}
		scrollCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		err = page.Context(scrollCtx).Mouse.Scroll(0, distance, 1)
		cancel()
		if err != nil {
			return err
		}
		nav.CardScrolls++
		humanize.Delay(ctx, humanize.BetweenScroll)
	}
	return fmt.Errorf("NOTE_CARD_NOT_FOUND")
}
