package xiaohongshu

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/go-rod/rod"
	"github.com/pkg/errors"
)

type LoginAction struct {
	page *rod.Page
}

func NewLogin(page *rod.Page) *LoginAction {
	return &LoginAction{page: page}
}

// A navigation menu is also rendered for guests. Authentication requires the
// site's non-guest account state, including an actual account identity.
const authenticatedStateScript = `() => {
 const unwrap=x=>x?.value??x?._value??x;
 const user=window.__INITIAL_STATE__?.user;
 const info=unwrap(user?.userInfo);
 return unwrap(user?.loggedIn)===true && info?.guest!==true &&
  /^[a-fA-F0-9]{24}$/.test(info?.userId||info?.user_id||'');
}`

// IsOverseasHost reports whether XHS served the page from RedNote, its
// international site. An account registered with a non-mainland phone number
// finishes the QR login there: the session is issued for .rednote.com only and
// www.xiaohongshu.com keeps treating the browser as a guest (HPC, 2026-11-02).
func IsOverseasHost(host string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	return host == "rednote.com" || strings.HasSuffix(host, ".rednote.com")
}

// ErrOverseasLogin: the QR login finished on rednote.com, so the session is a
// guest on xiaohongshu.com, where every read runs. It must not be saved.
var ErrOverseasLogin = errors.New("该账号登录到了海外版 RedNote，会话只对 rednote.com 有效，小红书网页仍是游客；请用中国大陆手机号注册的账号扫码")

// UsableSession says whether the session that just passed WaitForLogin may be
// saved for the crawler. Every login path (cmd/login, the MCP service) asks it
// before writing cookies; an unreadable page is not saved either.
func (a *LoginAction) UsableSession(ctx context.Context) error {
	r, err := a.page.Context(ctx).Timeout(5 * time.Second).Eval(`() => location.host`)
	if err != nil {
		return errors.Wrap(err, "read login host failed")
	}
	if host := r.Value.Str(); IsOverseasHost(host) {
		return errors.WithMessage(ErrOverseasLogin, host)
	}
	return nil
}

// AuthenticatedHere reads the account state of the page as it is, without
// navigating (CheckLoginStatus always opens xiaohongshu.com/explore first).
func (a *LoginAction) AuthenticatedHere(ctx context.Context) (bool, error) {
	return a.authenticated(ctx)
}

func (a *LoginAction) authenticated(ctx context.Context) (bool, error) {
	result, err := a.page.Context(ctx).Timeout(3 * time.Second).Eval(authenticatedStateScript)
	if err != nil {
		return false, err
	}
	return result.Value.Bool(), nil
}

func (a *LoginAction) CheckLoginStatus(ctx context.Context) (bool, error) {
	// 加超时保护：只是查登录态的快速检查，不应无限挂（登录扫码的等待在 Login/WaitForLogin 里）
	pp := a.page.Context(ctx).Timeout(30 * time.Second)
	pp.MustNavigate("https://www.xiaohongshu.com/explore").MustWaitLoad()

	time.Sleep(1 * time.Second)

	return a.authenticated(ctx)
}

// CurrentUser 当前登录用户的基础信息。
type CurrentUser struct {
	Nickname string `json:"nickname"`
	UserID   string `json:"userId"`
}

// CurrentUser 从当前页面的 __INITIAL_STATE__ 读取登录用户信息。
// 需在 CheckLoginStatus 之后调用：复用已加载的 explore 页，不做额外导航。
func (a *LoginAction) CurrentUser(ctx context.Context) (*CurrentUser, error) {
	pp := a.page.Context(ctx).Timeout(10 * time.Second)

	res, err := pp.Eval(`() => {
		const unwrap=x=>x?.value??x?._value??x;
		const u = window.__INITIAL_STATE__?.user;
		const info = unwrap(u?.userInfo);
		if (!info || info.guest || unwrap(u?.loggedIn)!==true || !/^[a-fA-F0-9]{24}$/.test(info.userId||info.user_id||'')) return "";
		return JSON.stringify({nickname: info.nickname, userId: info.userId || info.user_id});
	}`)
	if err != nil {
		return nil, errors.Wrap(err, "read current user state failed")
	}

	raw := res.Value.String()
	if raw == "" {
		return nil, errors.New("current user not found in page state")
	}

	var user CurrentUser
	if err := json.Unmarshal([]byte(raw), &user); err != nil {
		return nil, errors.Wrap(err, "unmarshal current user failed")
	}

	return &user, nil
}

func (a *LoginAction) Login(ctx context.Context) error {
	pp := a.page.Context(ctx)

	// 导航到小红书首页，这会触发二维码弹窗
	pp.MustNavigate("https://www.xiaohongshu.com/explore").MustWaitLoad()

	time.Sleep(2 * time.Second)

	if loggedIn, _ := a.authenticated(ctx); loggedIn {
		return nil
	}

	if !a.WaitForLogin(ctx) {
		return errors.New("login not completed")
	}
	return nil
}

func (a *LoginAction) FetchQrcodeImage(ctx context.Context) (string, bool, error) {
	pp := a.page.Context(ctx)

	// 导航到小红书首页，这会触发二维码弹窗
	pp.MustNavigate("https://www.xiaohongshu.com/explore").MustWaitLoad()

	time.Sleep(2 * time.Second)

	if loggedIn, _ := a.authenticated(ctx); loggedIn {
		return "", true, nil
	}

	src, err := pp.MustElement(".login-container .qrcode-img").Attribute("src")
	if err != nil {
		return "", false, errors.Wrap(err, "get qrcode src failed")
	}
	if src == nil || len(*src) == 0 {
		return "", false, errors.New("qrcode src is empty")
	}

	return *src, false, nil
}

func (a *LoginAction) WaitForLogin(ctx context.Context) bool {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return false
		case <-ticker.C:
			loggedIn, err := a.authenticated(ctx)
			if err == nil && loggedIn {
				return true
			}
		}
	}
}
