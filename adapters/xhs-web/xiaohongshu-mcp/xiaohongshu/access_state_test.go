package xiaohongshu

import "testing"

func TestAccessClassification(t *testing.T) {
	for _, r := range []struct{ path, title, body, want string }{
		{"/website-login/error", "安全限制", "访问频繁，请稍后再试", "CRAWLER_RATE_LIMITED"},
		{"/website-login/error", "安全限制", "访问受限", "CRAWLER_ACCESS_RESTRICTED"},
		{"/explore/abc", "a note", "访问频繁，请稍后再试", ""},
		{"/search_result", "", "电脑设备登录超限", "CRAWLER_RELOGIN_REQUIRED"},
		{"/website-login/error", "安全限制", "电脑设备登录超限", "CRAWLER_RELOGIN_REQUIRED"},
		{"/website-login/error", "安全限制", "访问频繁，请稍后再试 电脑设备登录超限", "CRAWLER_RATE_LIMITED"},
		{"/login", "小红书 - 你的生活兴趣社区", "", "CRAWLER_RELOGIN_REQUIRED"},
		{"/login/", "", "", "CRAWLER_RELOGIN_REQUIRED"},
		{"/website-login/captcha", "", "", "CRAWLER_VERIFICATION_REQUIRED"},
		{"/website-login/captcha", "", "请完成验证", "CRAWLER_VERIFICATION_REQUIRED"},
		{"/website-login/captcha", "安全限制", "请完成验证", "CRAWLER_VERIFICATION_REQUIRED"},
		{"/website-login/error", "安全限制", "请重新登录", "CRAWLER_RELOGIN_REQUIRED"},
		{"/website-login/error", "安全限制", "请完成验证", "CRAWLER_VERIFICATION_REQUIRED"},
		{"/website-login/error", "安全限制", "账号异常", "CRAWLER_ACCESS_RESTRICTED"},
		{"/explore/abc", "a note", "请完成验证 请重新登录 验证码", ""},
		{"/website-login/error", "安全限制", "验证码", "CRAWLER_ACCESS_RESTRICTED"},
		{"/explore/abc", "标题", "请先登录查看更多内容", ""},
		{"/user/profile/abc", "标题", "登录已过期", ""},
	} {
		if got := accessCode(r.path, r.title, r.body); got != r.want {
			t.Errorf("got %q want %q", got, r.want)
		}
	}
}
