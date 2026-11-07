package xiaohongshu

import (
	"net/url"
	"regexp"
	"strings"
	"time"
)

// AccessDiagnostic contains an allowlisted view, never a raw URL, page body,
// cookie, header or arbitrary query value. Unknown notices stay unknown.
type AccessDiagnostic struct {
	ObservedAt         string            `json:"observed_at"`
	Path               string            `json:"path"`
	PageReadyState     string            `json:"page_ready_state"`
	BodyPresent        bool              `json:"body_present"`
	RestrictionSurface bool              `json:"restriction_surface"`
	Notices            []string          `json:"notices"`
	ServerCodes        map[string]string `json:"server_codes"`
	Scope              string            `json:"scope"`
}

type AccessError struct {
	Code       string
	Diagnostic AccessDiagnostic
}

func (e *AccessError) Error() string { return e.Code }

var safeEvidencePath = regexp.MustCompile(`^/(explore/[a-fA-F0-9]{24}|user/profile/[a-fA-F0-9]{24}|apps/sns-poi/detail/[a-fA-F0-9]{8,64}|website-login/error|website-login/captcha|search_result|login)/?$`)
var numericErrorCode = regexp.MustCompile(`^-?[0-9]{1,9}$`)

// DiagnosticPath deliberately discards the entire query and fragment.
func DiagnosticPath(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return "/other"
	}
	if safeEvidencePath.MatchString(u.Path) {
		return u.Path
	}
	return "/other"
}

func accessDiagnostic(rawURL, title, body, ready string) AccessDiagnostic {
	u, _ := url.Parse(rawURL)
	path := ""
	if u != nil {
		path = u.Path
	}
	restricted := strings.Contains(path, "/website-login/error") || title == "安全限制"
	d := AccessDiagnostic{ObservedAt: time.Now().UTC().Format(time.RFC3339Nano), Path: DiagnosticPath(rawURL),
		BodyPresent: strings.TrimSpace(body) != "", RestrictionSurface: restricted,
		Notices: []string{}, ServerCodes: map[string]string{}, Scope: "unknown"}
	if ready == "loading" || ready == "interactive" || ready == "complete" {
		d.PageReadyState = ready
	}
	// Only exact visible phrases are retained. A post's arbitrary prose is never logged.
	if restricted || strings.Contains(body, "电脑设备登录超限") {
		for _, phrase := range []string{"访问频繁，请稍后再试", "访问频繁", "操作频繁", "访问受限", "安全限制", "电脑设备登录超限", "账号异常", "设备异常", "IP被封禁", "IP访问频繁", "登录失效", "请重新登录", "请完成验证", "验证码", "验证失败", "暂时无法访问", "网络异常"} {
			if strings.Contains(body, phrase) {
				d.Notices = append(d.Notices, phrase)
			}
		}
		if u != nil {
			for _, key := range []string{"code", "error_code", "errorCode"} {
				if value := u.Query().Get(key); numericErrorCode.MatchString(value) {
					d.ServerCodes[key] = value
				}
			}
		}
	}
	return d
}
