package xiaohongshu

import (
	"context"
	"time"

	"github.com/go-rod/rod"
)

// sessionStateJS reads what the page's own state says about the session:
// "guest" for a logged-out visitor, "user" when logged in, "" when unknown.
// Same source as CurrentUser (__INITIAL_STATE__.user.userInfo).
const sessionStateJS = `() => {
	const u = window.__INITIAL_STATE__ && window.__INITIAL_STATE__.user;
	const info = u && u.userInfo && u.userInfo.value !== undefined ? u.userInfo.value : (u && u.userInfo);
	if (!info || typeof info !== 'object') return '';
	if (info.guest === true) return 'guest';
	return info.userId || info.user_id ? 'user' : '';
}`

// SessionState reports "guest", "user" or "" (unknown) for the current page.
//
// A broken or expired web_session does not always redirect to the login page:
// XHS can serve the search page to a guest with no results (2026-10-07 smoke),
// which used to be recorded as an empty search while the guest cookies were
// saved over the login.
func SessionState(ctx context.Context, page *rod.Page) string {
	short, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	res, err := page.Context(short).Eval(sessionStateJS)
	if err != nil {
		return ""
	}
	return res.Value.Str()
}
