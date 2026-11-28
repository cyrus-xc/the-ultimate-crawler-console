package xiaohongshu

import (
	"context"
	"errors"
	"math/rand"
	"regexp"
	"strings"
	"time"

	"github.com/go-rod/rod"
	"github.com/sirupsen/logrus"
	"github.com/xpzouying/xiaohongshu-mcp/humanize"
)

// Human activity on the web account: idle explore browsing and following a
// chosen creator. Neither reads evidence; both stop on any access block.

var userIDPattern = regexp.MustCompile(`^[a-fA-F0-9]{24}$`)

const exploreURL = "https://www.xiaohongshu.com/explore"

const visibleExploreCardJS = `(skip) => {
 const seen=new Set(skip||[]);
 const cards=[...document.querySelectorAll('section.note-item a.cover')].filter(a=>{
  const r=a.getBoundingClientRect();
  const id=(a.getAttribute('href')||'').split('?')[0].split('/').pop();
  return r.width>40&&r.height>40&&r.top>80&&r.bottom<innerHeight-20&&!seen.has(id);
 });
 return cards.length?cards[Math.floor(Math.random()*cards.length)]:null;
}`

const cardIDJS = `function(){return (this.getAttribute('href')||'').split('?')[0].split('/').pop()}`

// BrowseExplore scrolls the explore feed for about seconds and opens up to
// opens notes on the way, reading each for a few seconds. It returns what it
// did. An access block ends it with that error.
func BrowseExplore(ctx context.Context, page *rod.Page, seconds, opens int) (map[string]any, error) {
	if seconds < 10 || seconds > 900 || opens < 0 || opens > 10 {
		return nil, errors.New("INVALID_BROWSE")
	}
	deadline := time.Now().Add(time.Duration(seconds) * time.Second)
	ctx, cancel := context.WithDeadline(ctx, deadline.Add(30*time.Second))
	defer cancel()
	page = page.Context(ctx)
	if r, err := page.Timeout(2*time.Second).Eval(`() => location.pathname`); err != nil || r.Value.Str() != "/explore" {
		navCtx, navCancel := context.WithTimeout(ctx, navTimeout)
		err := openInNewTab(navCtx, page, exploreURL)
		navCancel()
		if err != nil {
			return nil, err
		}
	}
	if err := waitScript(ctx, page, navTimeout, `() => document.querySelectorAll('section.note-item a.cover').length>0`); err != nil {
		return nil, err
	}
	humanize.Delay(ctx, humanize.AfterNavigate)
	scrolls, opened := 0, []string{}
	for time.Now().Before(deadline) {
		if err := checkAccess(page); err != nil {
			return nil, err
		}
		if len(opened) < opens && rand.Float64() < 0.35 {
			if id, err := readExploreNote(ctx, page, opened); err != nil {
				return nil, err
			} else if id != "" {
				opened = append(opened, id)
				continue
			}
		}
		// Uneven wheel distances, sometimes a short look back up.
		dy := 350 + rand.Float64()*650
		if rand.Float64() < 0.12 {
			dy = -(150 + rand.Float64()*250)
		}
		if err := page.Mouse.Scroll(0, dy, 1); err != nil {
			return nil, err
		}
		scrolls++
		humanize.Delay(ctx, humanize.BetweenScroll)
		if rand.Float64() < 0.4 {
			humanize.Delay(ctx, humanize.Reading)
		}
	}
	logrus.Infof("[activity] browse scrolls=%d opened=%d", scrolls, len(opened))
	return map[string]any{"scrolls": scrolls, "opened": len(opened)}, nil
}

func readExploreNote(ctx context.Context, page *rod.Page, skip []string) (string, error) {
	card, err := page.Timeout(2 * time.Second).ElementByJS(rod.Eval(visibleExploreCardJS, skip))
	if err != nil {
		return "", nil
	}
	id := ""
	if r, err := card.Eval(cardIDJS); err == nil {
		id = r.Value.Str()
	}
	humanize.Delay(ctx, humanize.BeforeClick)
	if err := humanize.Click(ctx, card); err != nil {
		return "", nil
	}
	if err := waitScript(ctx, page, 10*time.Second, visibleNoteJS); err != nil {
		if accessErr := checkAccess(page); accessErr != nil {
			return "", accessErr
		}
		return "", nil
	}
	// Read the note: a pause, a scroll through the text and some comments.
	humanize.Delay(ctx, humanize.Reading)
	for i, n := 0, 1+rand.Intn(4); i < n; i++ {
		_ = page.Mouse.Scroll(0, 200+rand.Float64()*350, 1)
		humanize.Delay(ctx, humanize.BetweenScroll)
		humanize.Delay(ctx, humanize.Reading)
	}
	if err := checkAccess(page); err != nil {
		return "", err
	}
	closeNoteOverlay(ctx, page, id)
	humanize.Delay(ctx, humanize.AfterClick)
	return id, nil
}

// The follow control on a profile page; its text tells the current state.
const followButtonJS = `() => {
 const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.top>=0&&r.bottom<=innerHeight};
 const roots=[...document.querySelectorAll('.user-info,.info-part,.info,.user')];
 const list=[...(roots.length?roots:[document]).flatMap(r=>[...r.querySelectorAll('button,.follow-button,.follow,.reds-button-new')])];
 return list.find(e=>visible(e)&&/^(关注|已关注|互相关注|回关|Follow|Following)$/.test((e.innerText||'').trim()))||null;
}`

// FollowUser opens uid's profile and follows it. It reports "followed",
// "already" when the account follows it already, or an error.
func FollowUser(ctx context.Context, page *rod.Page, uid, token string) (string, error) {
	if !userIDPattern.MatchString(uid) {
		return "", errors.New("INVALID_USER_ID")
	}
	if _, err := NewUserProfileAction(page).UserProfile(ctx, uid, token, TabNotes); err != nil {
		return "", err
	}
	// A person looks at the profile before deciding.
	humanize.Delay(ctx, humanize.Reading)
	_ = page.Context(ctx).Mouse.Scroll(0, 250+rand.Float64()*300, 1)
	humanize.Delay(ctx, humanize.Reading)
	_ = page.Context(ctx).Mouse.Scroll(0, -(250 + rand.Float64()*300), 1)
	humanize.Delay(ctx, humanize.BetweenScroll)
	button, err := page.Context(ctx).Timeout(5 * time.Second).ElementByJS(rod.Eval(followButtonJS))
	if err != nil {
		return "", errors.New("FOLLOW_BUTTON_NOT_FOUND")
	}
	text := ""
	if r, err := button.Eval(`function(){return (this.innerText||'').trim()}`); err == nil {
		text = r.Value.Str()
	}
	if text != "关注" && text != "回关" && text != "Follow" {
		return "already", nil
	}
	humanize.Delay(ctx, humanize.BeforeClick)
	if err := humanize.Click(ctx, button); err != nil {
		return "", err
	}
	if err := checkAccess(page.Context(ctx)); err != nil {
		return "", err
	}
	if err := waitScript(ctx, page, 8*time.Second, `() => {
	 const e=(`+followButtonJS+`)();return !!e&&/^(已关注|互相关注|Following)$/.test((e.innerText||'').trim());}`); err != nil {
		return "", errors.New("FOLLOW_NOT_CONFIRMED")
	}
	humanize.Delay(ctx, humanize.AfterInteract)
	return "followed", nil
}

// ActivityError maps an activity failure to a stable code for the service.
func ActivityError(err error) string {
	if err == nil {
		return ""
	}
	s := err.Error()
	for _, code := range []string{"INVALID_BROWSE", "INVALID_USER_ID", "INVALID_PUBLISH", "PUBLISH_ROOT_UNSET", "PUBLISH_IMAGE_OUTSIDE_ROOT", "FOLLOW_BUTTON_NOT_FOUND", "FOLLOW_NOT_CONFIRMED", "PROFILE_STATE_UNAVAILABLE"} {
		if strings.HasPrefix(s, code) {
			return code
		}
	}
	var access *AccessError
	if errors.As(err, &access) && access != nil && access.Code != "" {
		return access.Code
	}
	return "ACTIVITY_FAILED"
}
