package xiaohongshu

import (
	"context"
	"github.com/go-rod/rod"
	"net/url"
	"strings"
	"time"
)

// Only classify platform error/login surfaces, never words inside a creator's post.
func accessCode(path, title, body string) string {
	// Specific verification/login evidence takes precedence over the generic
	// "安全限制" title. A captcha is not an expired login; re-login is not its
	// recovery action. Never infer either from a generic account restriction.
	if strings.HasPrefix(path, "/website-login/captcha") {
		return "CRAWLER_VERIFICATION_REQUIRED"
	}
	restricted := strings.Contains(path, "/website-login/error") || title == "安全限制"
	if restricted && (strings.Contains(body, "访问频繁") || strings.Contains(body, "操作频繁")) {
		return "CRAWLER_RATE_LIMITED"
	}
	if strings.Contains(body, "电脑设备登录超限") {
		return "CRAWLER_RELOGIN_REQUIRED"
	}
	if restricted {
		if strings.Contains(body, "请完成验证") {
			return "CRAWLER_VERIFICATION_REQUIRED"
		}
		// The restriction path alone must not satisfy loginSurface: it would
		// turn every unknown account/IP restriction into a request to log in.
		if loginSurface("/other", body) {
			return "CRAWLER_RELOGIN_REQUIRED"
		}
		return "CRAWLER_ACCESS_RESTRICTED"
	}
	// 平台对未登录/失效会话做静默 302 到登录页（/login?redirectPath=...）。这是
	// 登录态失效，不是风控：必须报 CRAWLER_RELOGIN_REQUIRED，否则会被当成人
	// 访问限制，操作员看到的提示方向就错了。
	if loginSurface(path, body) {
		return "CRAWLER_RELOGIN_REQUIRED"
	}
	return ""
}

// loginSurface 判断当前页面是不是「登录态失效」的登录页（而非平台限制页）。
// 路径是最强信号；正文短语仅在非内容页上作为兜底，避免把创作者文案里的
// 普通措辞误判成登录失效。
func loginSurface(path, body string) bool {
	if path == "/login" || strings.HasPrefix(path, "/login/") || strings.Contains(path, "/website-login") {
		return true
	}
	if isContentPath(path) {
		return false
	}
	for _, phrase := range []string{"登录失效", "请重新登录", "登录已过期", "请先登录", "未登录"} {
		if strings.Contains(body, phrase) {
			return true
		}
	}
	return false
}

// isContentPath 标记正常内容页：这些页面上不会因正文短语判定登录态失效。
func isContentPath(path string) bool {
	for _, prefix := range []string{"/explore", "/user/profile", "/search_result", "/discovery"} {
		if strings.HasPrefix(path, prefix) {
			return true
		}
	}
	return false
}

func checkAccess(page *rod.Page) (result error) {
	// Capture the actual stopped page before its tab can close. This never
	// navigates, resumes the account, or substitutes a screenshot from a retry.
	defer func() {
		if access, ok := result.(*AccessError); ok {
			captureAlertPage(page, access.Code)
		}
	}()
	err := sampleAccess(page)
	access, ok := err.(*AccessError)
	if !ok || access.Code != "CRAWLER_ACCESS_RESTRICTED" || len(access.Diagnostic.Notices) > 0 {
		return err
	}
	// A redirect can precede the notice DOM. Read the same page for at most
	// 750 ms; never navigate, retry a request or clear a detected restriction.
	ctx, cancel := context.WithTimeout(page.GetContext(), 750*time.Millisecond)
	defer cancel()
	page = page.Context(ctx)
	for i := 0; i < 3; i++ {
		select {
		case <-page.GetContext().Done():
			return access
		case <-time.After(250 * time.Millisecond):
		}
		if next, ok := sampleAccess(page).(*AccessError); ok {
			access = next
			if access.Code != "CRAWLER_ACCESS_RESTRICTED" || len(access.Diagnostic.Notices) > 0 {
				break
			}
		}
	}
	return access
}

func sampleAccess(page *rod.Page) error {
	result, err := page.Eval(`() => [location.href, document.title, document.body?.innerText || '', document.readyState]`)
	if err != nil {
		return err
	}
	values := result.Value.Arr()
	if len(values) == 4 {
		u, parseErr := url.Parse(values[0].Str())
		if parseErr != nil {
			return parseErr
		}
		if code := accessCode(u.Path, values[1].Str(), values[2].Str()); code != "" {
			return &AccessError{Code: code, Diagnostic: accessDiagnostic(values[0].Str(), values[1].Str(), values[2].Str(), values[3].Str())}
		}
	}
	return nil
}

// A terminal access page must stop the queue immediately, not wait for missing data.
// A captcha/rate-limit overlay is NOT terminal: wait for it to clear first,
// otherwise the readiness probe never advances and the read burns its whole
// budget. If it does not clear, return CRAWLER_RATE_LIMITED for backoff.
func waitEvidenceReady(ctx context.Context, page *rod.Page, script string) error {
	for {
		if err := checkAccess(page.Context(ctx)); err != nil {
			return err
		}
		if err := WaitForRestrictionOverlay(ctx, page); err != nil {
			return err
		}
		result, err := page.Context(ctx).Eval(script)
		if err != nil {
			return err
		}
		if result.Value.Bool() {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
}
